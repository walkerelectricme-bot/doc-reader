/**
 * speaker.js: reads a list of sentences out loud with the browser's speechSynthesis, one sentence per utterance.
 *
 * Why one sentence at a time:
 *  - Android Chrome cuts off long utterances, and its word-boundary events are unreliable, so the app highlights the
 *    whole current sentence (utterance onstart / onend) instead of single words.
 *  - Pause is done as cancel + remember the sentence (speechSynthesis.pause() is a no-op or a cancel on Android), and
 *    Play starts that sentence again. Seeking (back/forward, tap a paragraph) is the same: cancel, then speak from i.
 * Chrome bugs handled:
 *  - Utterances can be garbage-collected mid-speech and never fire onend: the current one is kept in this.utt.
 *  - speak() right after cancel() is sometimes dropped: a short gap (SPEAK_GAP_MS) between them.
 *  - Speech sometimes stalls (no onstart, or no onend long after it should have finished): a watchdog re-speaks the
 *    sentence once, then skips to the next one, so reading never silently hangs.
 *  - Desktop Chrome stops speaking after ~15 s of one utterance: our chunks are short (text.js), so it never gets there.
 * The engine is pure logic around an injected synth + timers, so node tests can drive it with a fake.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DRSpeaker = factory();
}(this, function () {
  'use strict';

  var SPEAK_GAP_MS = 60;
  var START_TIMEOUT_MS = 5000;   // no onstart by then = stalled
  var CHARS_PER_SEC = 12;        // slow estimate at 1x, so the end watchdog never fires on a normal sentence

  /**
   * opts: {synth, Utterance, setTimeout, clearTimeout, onSentence(i), onState(state), onEnd(), onError(msg)}
   * state: 'playing' | 'paused' | 'ended'
   */
  function Speaker(opts) {
    this.o = opts || {};
    this.synth = this.o.synth;
    this.Utt = this.o.Utterance;
    this.st = this.o.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    this.ct = this.o.clearTimeout || function (t) { clearTimeout(t); };
    this.sentences = [];
    this.i = 0;
    this.rate = 1;
    this.voice = null;
    this.lang = '';
    this.playing = false;
    this.token = 0;         // bumps on every (re)start, so stale utterance events are ignored
    this.utt = null;
    this.timers = [];
    this.retries = 0;
    this.stalls = 0;        // for tests / diagnostics
    this.hidden = false;
  }

  Speaker.prototype.load = function (sentences, i) {
    this.stop(true);
    this.ended = false;
    this.sentences = sentences || [];
    this.i = clampI(this, i || 0);
  };

  Speaker.prototype.setRate = function (r) {
    r = Number(r) || 1;
    this.rate = r < 0.5 ? 0.5 : r > 2 ? 2 : r;
    if (this.playing) this.restart_(); // takes effect on the current sentence
  };

  Speaker.prototype.setVoice = function (v) {
    this.voice = v || null;
    if (this.playing) this.restart_();
  };

  Speaker.prototype.play = function (i) {
    if (!this.sentences.length) return;
    if (typeof i === 'number') this.i = clampI(this, i);
    else if (this.ended || this.i >= this.sentences.length) this.i = 0; // Play after the end starts over
    this.ended = false;
    this.playing = true;
    this.emitState_('playing');
    this.restart_(true);
  };

  Speaker.prototype.pause = function () {
    if (!this.playing) return;
    this.stop(false);
    this.emitState_('paused');
  };

  Speaker.prototype.toggle = function () { if (this.playing) this.pause(); else this.play(); };

  /** Move to sentence i; keeps playing if it was playing. */
  Speaker.prototype.seek = function (i) {
    this.i = clampI(this, i);
    this.ended = false;
    if (this.o.onSentence) this.o.onSentence(this.i);
    if (this.playing) this.restart_();
  };

  Speaker.prototype.stop = function (silent) {
    this.playing = false;
    this.token++;
    this.clearTimers_();
    this.utt = null;
    try { if (this.synth) this.synth.cancel(); } catch (e) { /* ignore */ }
    if (!silent) { /* state emitted by caller */ }
  };

  /** True if the engine thinks it is reading but the synth is silent (e.g. after the phone screen came back on). */
  Speaker.prototype.isStuck = function () {
    return this.playing && this.synth && !this.synth.speaking && !this.synth.pending;
  };

  /**
   * The page was hidden (screen locked / app switched). Android Chrome stops web speech then; some phones keep going.
   * While hidden the stall watchdog stands down (it must not skip through the doc while the browser refuses to speak).
   */
  Speaker.prototype.sleep = function () { this.hidden = true; };

  /** The page is visible again: if speech died while hidden, start the current sentence again. */
  Speaker.prototype.wake = function () {
    this.hidden = false;
    if (this.isStuck()) this.restart_();
  };

  /**
   * (Re)start the current sentence. When the synth is idle and this comes straight from a tap (Play), speak right away:
   * iPhone Safari only allows speech that starts inside the tap itself. Otherwise cancel, wait a moment, then speak.
   */
  Speaker.prototype.restart_ = function (fromTap) {
    var self = this;
    this.token++;
    var tok = this.token;
    this.clearTimers_();
    this.retries = 0;
    var busy = !!(this.synth.speaking || this.synth.pending);
    if (fromTap && !busy) { this.speakCurrent_(tok); return; }
    try { this.synth.cancel(); } catch (e) { /* ignore */ }
    this.later_(function () { if (tok === self.token) self.speakCurrent_(tok); }, SPEAK_GAP_MS);
  };

  Speaker.prototype.speakCurrent_ = function (tok) {
    var self = this;
    if (!this.playing || tok !== this.token) return;
    if (this.i >= this.sentences.length) { this.finish_(); return; }
    var s = this.sentences[this.i];
    var u = new this.Utt(s.text);
    u.rate = this.rate;
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else if (this.lang) u.lang = this.lang;
    var started = false;
    u.onstart = function () {
      if (tok !== self.token) return;
      started = true;
      if (self.o.onSentence) self.o.onSentence(self.i);
      // end watchdog: far longer than this sentence could take at this speed
      var ms = Math.max(8000, (s.text.length / (CHARS_PER_SEC * self.rate)) * 1000 * 2.5 + 4000);
      self.later_(function () { if (tok === self.token) self.stalled_(tok); }, ms);
    };
    u.onend = function () {
      if (tok !== self.token) return;
      self.advance_();
    };
    u.onerror = function (ev) {
      if (tok !== self.token) return;
      var err = ev && ev.error;
      if (err === 'interrupted' || err === 'canceled') return; // our own cancel
      if (err === 'not-allowed') { self.pause(); if (self.o.onError) self.o.onError('Tap Play to start reading.'); return; }
      self.advance_(); // synthesis-failed, audio-busy...: skip this sentence rather than hang
    };
    this.utt = u; // keep a reference: Chrome can garbage-collect a playing utterance and drop its onend
    if (this.o.onSentence) this.o.onSentence(this.i); // highlight right away; onstart confirms it
    this.synth.speak(u);
    this.later_(function () { if (tok === self.token && !started) self.stalled_(tok); }, START_TIMEOUT_MS);
  };

  Speaker.prototype.stalled_ = function (tok) {
    if (tok !== this.token || !this.playing) return;
    if (this.hidden) return; // wake() takes over when the screen comes back
    this.stalls++;
    if (this.retries < 1) {
      var r = this.retries + 1;
      this.restart_();
      this.retries = r;
    } else {
      this.advance_();
    }
  };

  Speaker.prototype.advance_ = function () {
    this.i++;
    if (this.i >= this.sentences.length) { this.finish_(); return; }
    var self = this;
    this.token++;
    var tok = this.token;
    this.clearTimers_();
    this.retries = 0;
    this.utt = null;
    // no cancel() between natural sentences: the synth is already idle
    this.later_(function () { self.speakCurrent_(tok); }, 0);
  };

  Speaker.prototype.finish_ = function () {
    this.stop(true);
    this.i = this.sentences.length ? this.sentences.length - 1 : 0;
    this.ended = true;
    this.emitState_('ended');
    if (this.o.onEnd) this.o.onEnd();
  };

  Speaker.prototype.later_ = function (f, ms) { this.timers.push(this.st(f, ms)); };
  Speaker.prototype.clearTimers_ = function () { var ct = this.ct; this.timers.forEach(function (t) { ct(t); }); this.timers = []; };
  Speaker.prototype.emitState_ = function (s) { if (this.o.onState) this.o.onState(s); };

  function clampI(self, i) {
    var n = self.sentences.length;
    i = Number(i) || 0;
    return n ? (i < 0 ? 0 : i > n - 1 ? n - 1 : i) : 0;
  }

  /** Order voices for the picker: the phone's language first, local (offline) voices before network ones, then by name. */
  function sortVoices(voices, lang) {
    var base = String(lang || 'en').toLowerCase().split('-')[0];
    var full = String(lang || '').toLowerCase();
    function score(v) {
      var l = String(v.lang || '').toLowerCase().replace('_', '-');
      return (l === full ? 0 : l.split('-')[0] === base ? 1 : 2) * 10 + (v.localService ? 0 : 1);
    }
    return (voices || []).slice().sort(function (a, b) {
      return score(a) - score(b) || String(a.name).localeCompare(String(b.name));
    });
  }

  /** The saved voice (by voiceURI, then name) if this phone still has it. */
  function findVoice(voices, saved) {
    if (!saved) return null;
    for (var j = 0; j < voices.length; j++) if (voices[j].voiceURI === saved) return voices[j];
    for (var k = 0; k < voices.length; k++) if (voices[k].name === saved) return voices[k];
    return null;
  }

  return { Speaker: Speaker, sortVoices: sortVoices, findVoice: findVoice, SPEAK_GAP_MS: SPEAK_GAP_MS, START_TIMEOUT_MS: START_TIMEOUT_MS };
}));
