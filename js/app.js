/**
 * app.js: the Doc Reader screens. Setup (paste your link) -> Library (saved, recent, starred, search, paste a Doc link)
 * -> Reader (text with the current sentence highlighted, big player controls).
 *  - Docs are saved on the phone (IndexedDB) the first time they open, so they play later with no signal.
 *  - The reading spot is saved per doc on every sentence and comes back when the doc is opened again.
 *  - While reading: Screen Wake Lock keeps the screen on; Media Session shows the title and maps headset/lock-screen
 *    buttons where the phone offers them; "Black screen" covers the screen in black (saves battery on OLED phones).
 *  - Honest limit: Android Chrome stops web speech when Chrome is not visible (screen off or another app). We pause
 *    cleanly there and pick up the same sentence when the screen comes back (GO-LIVE.md "Screen off and background").
 */
(function () {
  'use strict';
  var T = window.DRText, S = window.DRSpeaker, cfg = window.DR_CONFIG || {};
  var LS = { key: 'dr.key', rate: 'dr.rate', voice: 'dr.voice', size: 'dr.size', last: 'dr.lastDoc', tab: 'dr.tab',
             tipOff: 'dr.installTipOff', list: 'dr.listCache' };
  var $ = function (id) { return document.getElementById(id); };
  var ICON_PLAY = '<svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true" fill="currentColor"><path d="M6 4.5h4.2v15H6zM13.8 4.5H18v15h-4.2z"/></svg>';
  var store = new window.DRStore.Store();
  var remote = null;
  var synth = window.speechSynthesis || null;

  var state = { screen: '', tab: 'recent', doc: null, sentences: [], paraStarts: [], cur: 0, playing: false, voices: [],
                userScrollUntil: 0, wakeLock: null, wasPlayingWhenHidden: false };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* full / private */ } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500);
  }

  /* ------------------------------------------------ key / setup ------------------------------------------------ */

  function takeKeyFromUrl() {
    var k = T.parseKey(location.search) || T.parseKey(location.hash);
    if (k) {
      lsSet(LS.key, k);
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    }
  }

  function connect() {
    remote = new window.DRRemote.Remote(cfg.execUrl, lsGet(LS.key), { version: cfg.version });
  }

  function showSetup(msg) {
    show('setup');
    $('setupMsg').textContent = msg || '';
    $('setupMsg').className = 'msg' + (msg ? ' err' : '');
  }

  $('keyBtn').onclick = function () {
    var k = T.parseKey($('keyInput').value);
    if (!k) { showSetup('That does not look like a Doc Reader link. It should end with ?k= and a long code.'); return; }
    lsSet(LS.key, k);
    connect();
    $('setupMsg').className = 'msg'; $('setupMsg').textContent = 'Checking…';
    remote.call('ping').then(function () { $('keyInput').value = ''; go('#library'); }, function (err) {
      if (err.code === 'OFFLINE') { go('#library'); toast('Saved. No signal right now; your Docs will show when it comes back.'); return; }
      if (err.code === 'BAD_KEY') lsSet(LS.key, null);
      showSetup(err.message);
    });
  };

  /* ------------------------------------------------ screens / routing ------------------------------------------------ */

  function show(name) {
    state.screen = name;
    ['setup', 'library', 'reader'].forEach(function (s) { $(s).hidden = s !== name; });
    $('player').hidden = name !== 'reader';
    $('backBtn').hidden = name !== 'reader';
    $('moreBtn').hidden = name === 'setup';
    $('docActions').hidden = name !== 'reader';
    if (name !== 'reader') $('barTitle').textContent = 'Doc Reader';
    var tip = $('tip'); if (tip) tip.hidden = name === 'reader'; // keep the reading screen clear
  }

  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  function route() {
    if (!lsGet(LS.key)) { stopReading(); showSetup(''); return; }
    var m = /^#doc\/([A-Za-z0-9_-]+)/.exec(location.hash);
    if (m) { openDoc(m[1]); return; }
    stopReading();
    showLibrary();
  }
  window.addEventListener('hashchange', route);
  $('backBtn').onclick = function () { go('#library'); };

  /* ------------------------------------------------ library ------------------------------------------------ */

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var now = new Date();
    var opts = d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
    return d.toLocaleDateString(undefined, opts);
  }

  function showLibrary() {
    show('library');
    store.listDocs().then(function (saved) {
      state.saved = saved;
      if (!lsGet(LS.tab)) state.tab = saved.length ? 'saved' : 'recent';
      drawResume();
      selectTab(state.tab, true);
    });
  }

  function drawResume() {
    var last = lsGet(LS.last);
    var box = $('resume');
    var hit = (state.saved || []).filter(function (d) { return d.id === last; })[0];
    if (!hit) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<button type="button"><small>Continue listening</small><b>' + esc(hit.title) + '</b></button>';
    box.firstChild.onclick = function () { go('#doc/' + hit.id); };
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.onclick = function () { lsSet(LS.tab, b.getAttribute('data-tab')); selectTab(b.getAttribute('data-tab')); };
  });

  function selectTab(tab, quiet) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      var on = b.getAttribute('data-tab') === tab;
      b.className = 'tab' + (on ? ' on' : ''); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('searchForm').hidden = tab === 'saved';
    if (tab === 'saved') { drawSaved(); return; }
    loadDrive(tab, '', quiet);
  }

  function drawSaved() {
    var saved = state.saved || [];
    msg(saved.length ? '' : 'Nothing saved yet. Docs you open are kept here so they play with no signal.');
    drawList(saved.map(function (d) { return { id: d.id, title: d.title, meta: 'On this phone · ' + fmtDate(new Date(d.saved).toISOString()) }; }));
  }

  function msg(text, err) { $('libMsg').textContent = text || ''; $('libMsg').className = 'msg' + (err ? ' err' : ''); }

  var listSeq = 0;
  function loadDrive(mode, q, quiet) {
    var seq = ++listSeq;
    var cacheKey = mode + '|' + q;
    var cached = null;
    try { cached = JSON.parse(lsGet(LS.list) || '{}')[cacheKey]; } catch (e) { cached = null; }
    if (cached) drawDriveList(cached);
    else drawList([]);
    msg(q ? 'Searching…' : 'Loading your Docs…');
    remote.call('list', { mode: mode, q: q }).then(function (res) {
      if (seq !== listSeq) return;
      if (!q) { var all = {}; try { all = JSON.parse(lsGet(LS.list) || '{}'); } catch (e) { all = {}; } all[cacheKey] = res.docs; lsSet(LS.list, JSON.stringify(all)); }
      drawDriveList(res.docs);
      msg(res.docs.length ? '' : (q ? 'No Docs match “' + q + '”.' : mode === 'starred' ? 'No starred Docs. Star a Doc in Google Docs to see it here.' : 'No Docs found.'));
    }, function (err) {
      if (seq !== listSeq) return;
      if (err.code === 'BAD_KEY') { lsSet(LS.key, null); showSetup(err.message); return; }
      msg(err.code === 'OFFLINE' ? (cached ? 'No signal. Showing the last list; saved Docs still play.' : 'No signal. Saved Docs still play (On phone).') : err.message, err.code !== 'OFFLINE');
    });
  }

  function drawDriveList(docs) {
    var savedIds = {};
    (state.saved || []).forEach(function (d) { savedIds[d.id] = 1; });
    drawList((docs || []).map(function (d) {
      return { id: d.id, title: d.title, meta: (savedIds[d.id] ? 'On phone · ' : '') + (d.modified ? 'Edited ' + fmtDate(d.modified) : '') };
    }));
  }

  function drawList(items) {
    var ul = $('docList');
    ul.innerHTML = items.map(function (d) {
      return '<li><button type="button" data-id="' + esc(d.id) + '"><span class="t">' + esc(d.title) + '</span><span class="m">' + esc(d.meta || '') + '</span></button></li>';
    }).join('');
  }

  $('docList').onclick = function (ev) {
    var b = ev.target.closest('button[data-id]');
    if (b) go('#doc/' + b.getAttribute('data-id'));
  };

  $('searchForm').onsubmit = function (ev) {
    ev.preventDefault();
    var q = $('searchInput').value.trim();
    if (state.tab === 'saved') selectTab('recent');
    loadDrive(state.tab === 'starred' ? 'starred' : 'recent', q);
  };

  $('pasteForm').onsubmit = function (ev) {
    ev.preventDefault();
    var id = T.parseDocId($('pasteInput').value);
    if (!id) { msg('That does not look like a Google Docs link.', true); return; }
    $('pasteInput').value = '';
    go('#doc/' + id);
  };

  /* ------------------------------------------------ open a doc ------------------------------------------------ */

  var openSeq = 0;
  function openDoc(id) {
    var seq = ++openSeq;
    if (state.doc && state.doc.id === id && state.screen === 'reader') return;
    stopReading();
    show('reader');
    $('barTitle').textContent = 'Opening…';
    $('text').innerHTML = '';
    status('Opening…');
    store.getDoc(id).then(function (saved) {
      if (seq !== openSeq) return;
      if (saved) {
        return showDoc(saved).then(function () { checkForUpdate(saved, seq); });
      }
      status('Downloading…');
      return remote.call('doc', { id: id }).then(function (doc) {
        return store.putDoc(doc);
      }).then(function (rec) {
        if (seq !== openSeq) return;
        return showDoc(rec);
      }, function (err) {
        if (seq !== openSeq) return;
        if (err.code === 'BAD_KEY') { lsSet(LS.key, null); showSetup(err.message); return; }
        $('barTitle').textContent = 'Could not open';
        $('text').innerHTML = '<p class="msg err">' + esc(err.code === 'OFFLINE' ? 'No signal, and this Doc is not saved on the phone yet. Try again with signal.' : err.message) + '</p>';
        status('');
      });
    });
  }

  /** With signal, quietly fetch the doc again; if it changed and nothing is playing yet, swap in the new text. */
  function checkForUpdate(saved, seq) {
    if (!navigator.onLine) return;
    remote.call('doc', { id: saved.id }).then(function (fresh) {
      if (seq !== openSeq || !state.doc || state.doc.id !== saved.id) return;
      if (fresh.revision && fresh.revision === saved.revision) return;
      if (JSON.stringify(fresh.paragraphs) === JSON.stringify(saved.paragraphs)) { store.putDoc(fresh); return; }
      store.putDoc(fresh).then(function (rec) {
        if (state.playing) { toast('A newer version was saved. It will be used next time you open this Doc.'); return; }
        showDoc(rec).then(function () { toast('Updated to the latest version.'); });
      });
    }, function () { /* no signal or no access: keep the saved copy */ });
  }

  function showDoc(doc) {
    state.doc = doc;
    lsSet(LS.last, doc.id);
    $('barTitle').textContent = doc.title;
    document.title = doc.title + ' · Doc Reader';
    state.sentences = T.buildSentences(doc.paragraphs);
    state.paraStarts = T.paragraphStarts(state.sentences, doc.paragraphs.length);
    renderText(doc.paragraphs);
    return store.getPos(doc.id).then(function (pos) {
      var i = T.resolvePos(state.sentences, pos);
      speaker.load(state.sentences, i);
      setCurrent(i, true);
      setPlaying(false);
      mediaMeta();
      if (!state.sentences.length) status('This Doc has no text to read.');
      else if (pos && i > 0) status('Picking up where you left off');
    });
  }

  function renderText(paragraphs) {
    var bySent = {};
    state.sentences.forEach(function (s) { (bySent[s.p] = bySent[s.p] || []).push(s); });
    var html = paragraphs.map(function (para, p) {
      var inner = (bySent[p] || []).map(function (s) { return '<span class="s" data-i="' + s.i + '">' + esc(s.text) + '</span>'; }).join(' ');
      if (!inner) return '';
      if (para.t === 'h') {
        var lv = Math.min(Math.max(para.level || 0, 0), 4);
        var tag = lv <= 1 ? 'h2' : lv === 2 ? 'h3' : 'h4';
        return '<' + tag + ' class="h' + lv + '" data-p="' + p + '">' + inner + '</' + tag + '>';
      }
      if (para.t === 'li') {
        var mark = para.n ? para.n + '.' : ['•', '◦', '▪'][(para.level || 0) % 3];
        return '<p class="li" style="--lvl:' + (para.level || 0) + '" data-mark="' + esc(mark) + '" data-p="' + p + '">' + inner + '</p>';
      }
      return '<p' + (para.table ? ' class="tr"' : '') + ' data-p="' + p + '">' + inner + '</p>';
    }).join('');
    $('text').innerHTML = html;
  }

  /* ------------------------------------------------ reading ------------------------------------------------ */

  var speaker = new S.Speaker({
    synth: synth || fakeSilentSynth(),
    Utterance: window.SpeechSynthesisUtterance || function (t) { this.text = t; },
    onSentence: function (i) { setCurrent(i); },
    onState: function (st) {
      setPlaying(st === 'playing');
      if (st === 'ended') { status('Finished'); savePos(state.sentences.length - 1); }
    },
    onError: function (m) { toast(m); }
  });

  function fakeSilentSynth() {
    return { speaking: false, pending: false, speak: function () { toast('This browser cannot read out loud.'); }, cancel: function () {}, getVoices: function () { return []; } };
  }

  var lastEl = null;
  function setCurrent(i, initial) {
    state.cur = i;
    if (lastEl) lastEl.classList.remove('on');
    var el = $('text').querySelector('.s[data-i="' + i + '"]');
    if (el) {
      el.classList.add('on');
      lastEl = el;
      if (Date.now() > state.userScrollUntil) scrollToSentence(el, initial);
    }
    var n = state.sentences.length;
    $('progressFill').style.width = n ? Math.round(((i + 1) / n) * 100) + '%' : '0';
    if (!initial) savePos(i);
    if (state.playing || !initial) status(statusLine(i));
    updateMediaPosition();
  }

  function statusLine(i) {
    var s = state.sentences[i];
    if (!s) return '';
    var paras = state.doc ? state.doc.paragraphs.length : 0;
    var left = T.minutesLeft(state.sentences, i, speaker.rate);
    return 'Paragraph ' + (s.p + 1) + ' of ' + paras + (left ? ' · about ' + left + ' min left' : '');
  }

  function scrollToSentence(el, initial) {
    var r = el.getBoundingClientRect();
    var top = 70, bottom = window.innerHeight - ($('player').offsetHeight || 200) - 20;
    if (initial || r.top < top || r.bottom > bottom) {
      var y = window.scrollY + r.top - Math.max(top, (bottom - top) * 0.35);
      window.scrollTo({ top: Math.max(0, y), behavior: initial ? 'auto' : 'smooth' });
    }
  }

  // after the person scrolls by hand, leave the page where they put it for a few seconds
  ['touchmove', 'wheel'].forEach(function (evName) {
    window.addEventListener(evName, function () { if (state.screen === 'reader') state.userScrollUntil = Date.now() + 6000; }, { passive: true });
  });

  var posTimer;
  function savePos(i) {
    if (!state.doc) return;
    var id = state.doc.id, pos = T.makePos(state.sentences, i);
    clearTimeout(posTimer);
    posTimer = setTimeout(function () { store.putPos(id, pos); }, 300);
  }

  function status(t) { $('status').textContent = t || ''; }

  function setPlaying(on) {
    state.playing = on;
    var b = $('playBtn');
    b.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
    b.setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (on) { wakeLock(true); status(statusLine(state.cur)); } else { wakeLock(false); if (state.sentences.length && state.screen === 'reader') status('Paused · ' + statusLine(state.cur)); }
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
    if (!on) $('black').hidden = true;
  }

  function stopReading() {
    if (state.playing) speaker.pause();
    speaker.stop(true);
    setPlaying(false);
    state.doc = null;
    document.title = 'Doc Reader';
  }

  $('playBtn').onclick = function () { speaker.toggle(); };
  $('prevSent').onclick = function () { speaker.seek(state.cur - 1); };
  $('nextSent').onclick = function () { speaker.seek(state.cur + 1); };
  $('prevPara').onclick = function () { speaker.seek(T.prevParagraphIndex(state.sentences, state.cur)); };
  $('nextPara').onclick = function () { speaker.seek(T.nextParagraphIndex(state.sentences, state.cur)); };

  // tap any sentence (or anywhere in a paragraph) to read from there
  $('text').onclick = function (ev) {
    var s = ev.target.closest('.s');
    var i = s ? Number(s.getAttribute('data-i')) : NaN;
    if (isNaN(i)) {
      var p = ev.target.closest('[data-p]');
      if (!p) return;
      i = state.paraStarts[Number(p.getAttribute('data-p'))];
      if (i < 0 || i === undefined) return;
    }
    state.userScrollUntil = 0;
    speaker.play(i);
  };

  /* ------------------------------------------------ wake lock / media session / visibility ------------------------------------------------ */

  function wakeLock(on) {
    if (!('wakeLock' in navigator)) return;
    if (on && !state.wakeLock && document.visibilityState === 'visible') {
      navigator.wakeLock.request('screen').then(function (l) {
        state.wakeLock = l;
        l.addEventListener('release', function () { if (state.wakeLock === l) state.wakeLock = null; });
        if (!state.playing) { l.release(); }
      }, function () { /* battery saver or not allowed: fine */ });
    } else if (!on && state.wakeLock) {
      var l = state.wakeLock; state.wakeLock = null; l.release().catch(function () {});
    }
  }

  function mediaMeta() {
    if (!('mediaSession' in navigator) || !state.doc) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: state.doc.title, artist: 'Doc Reader', album: 'Google Docs',
        artwork: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
      });
      var h = {
        play: function () { speaker.play(); }, pause: function () { speaker.pause(); }, stop: function () { speaker.pause(); },
        previoustrack: function () { $('prevPara').onclick(); }, nexttrack: function () { $('nextPara').onclick(); },
        seekbackward: function () { $('prevSent').onclick(); }, seekforward: function () { $('nextSent').onclick(); }
      };
      Object.keys(h).forEach(function (a) { try { navigator.mediaSession.setActionHandler(a, h[a]); } catch (e) { /* not supported */ } });
    } catch (e) { /* no MediaMetadata */ }
  }

  function updateMediaPosition() { /* sentences have no reliable duration; the title + buttons are what matters */ }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      state.wasPlayingWhenHidden = state.playing;
      speaker.sleep();
      if (state.doc) store.putPos(state.doc.id, T.makePos(state.sentences, state.cur));
    } else {
      if (state.playing) {
        wakeLock(true);
        var stuck = speaker.isStuck();
        speaker.wake();
        if (stuck) toast('Reading stopped while the screen was off. Picking up from this sentence.');
      }
    }
  });

  /* ------------------------------------------------ black screen ------------------------------------------------ */

  $('darkBtn').onclick = function () {
    if (!state.playing) speaker.play();
    $('black').hidden = false;
  };
  $('black').addEventListener('dblclick', function () { $('black').hidden = true; });
  var lastTap = 0;
  $('black').addEventListener('touchend', function (ev) {
    var now = Date.now();
    if (now - lastTap < 400) { $('black').hidden = true; ev.preventDefault(); }
    lastTap = now;
  });

  /* ------------------------------------------------ settings ------------------------------------------------ */

  function loadVoices() {
    if (!synth) return;
    var all = synth.getVoices() || [];
    if (!all.length) return;
    state.voices = S.sortVoices(all, navigator.language || 'en-US');
    var saved = lsGet(LS.voice);
    var v = S.findVoice(state.voices, saved);
    speaker.voice = v;
    speaker.lang = navigator.language || 'en-US';
    var sel = $('voiceSelect');
    sel.innerHTML = '<option value="">Phone default</option>' + state.voices.map(function (vo) {
      return '<option value="' + esc(vo.voiceURI) + '">' + esc(vo.name + ' (' + vo.lang + ')' + (vo.localService ? '' : ' · needs signal')) + '</option>';
    }).join('');
    sel.value = v ? v.voiceURI : '';
    $('voiceBtn').textContent = v ? shortVoice(v.name) : 'Voice';
  }
  function shortVoice(n) { n = String(n).replace(/^(Google|Microsoft|Apple)\s+/i, ''); return n.length > 16 ? n.slice(0, 15) + '…' : n; }
  if (synth) {
    loadVoices();
    if ('onvoiceschanged' in synth || synth.addEventListener) {
      try { synth.addEventListener('voiceschanged', loadVoices); } catch (e) { synth.onvoiceschanged = loadVoices; }
    }
    setTimeout(loadVoices, 800); // some Androids never fire voiceschanged
  }

  function applyRate(r) {
    speaker.setRate(r);
    var r2 = Math.round(speaker.rate * 100) / 100, label = (r2 % 1 === 0 ? r2.toFixed(1) : String(r2)) + '×';
    $('rateVal').textContent = label; $('speedBtn').textContent = label; $('rateInput').value = speaker.rate;
    lsSet(LS.rate, String(speaker.rate));
  }
  function applySize(pct) {
    pct = Math.min(160, Math.max(80, Number(pct) || 100));
    document.documentElement.style.setProperty('--size', String(pct / 100));
    $('sizeVal').textContent = pct + '%'; $('sizeInput').value = pct;
    lsSet(LS.size, String(pct));
  }
  speaker.rate = Number(lsGet(LS.rate)) || 1;
  applyRate(speaker.rate);
  applySize(lsGet(LS.size) || 100);

  var SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 0.5];
  $('speedBtn').onclick = function () {
    var cur = speaker.rate, next = SPEEDS[0];
    for (var j = 0; j < SPEEDS.length; j++) if (Math.abs(SPEEDS[j] - cur) < 0.01) { next = SPEEDS[(j + 1) % SPEEDS.length]; break; }
    applyRate(next);
  };
  $('rateInput').oninput = function () { applyRate(this.value); };
  $('sizeInput').oninput = function () { applySize(this.value); };
  $('voiceSelect').onchange = function () {
    var v = S.findVoice(state.voices, this.value);
    lsSet(LS.voice, v ? v.voiceURI : null);
    speaker.setVoice(v);
    $('voiceBtn').textContent = v ? shortVoice(v.name) : 'Voice';
  };
  $('testVoice').onclick = function () {
    if (!synth) { toast('This browser cannot read out loud.'); return; }
    if (state.playing) speaker.pause();
    synth.cancel();
    var u = new window.SpeechSynthesisUtterance('This is how your Docs will sound.');
    u.rate = speaker.rate; if (speaker.voice) { u.voice = speaker.voice; u.lang = speaker.voice.lang; }
    synth.speak(u);
  };

  function openSheet() {
    loadVoices();
    $('aboutLine').textContent = 'Doc Reader ' + (cfg.version || '') + (state.doc ? ' · ' + state.sentences.length + ' sentences in this Doc' : '');
    $('sheet').hidden = false;
  }
  $('moreBtn').onclick = openSheet;
  $('voiceBtn').onclick = openSheet;
  $('sheetClose').onclick = function () { $('sheet').hidden = true; };
  $('sheet').onclick = function (ev) { if (ev.target === this) this.hidden = true; };

  $('refreshDoc').onclick = function () {
    if (!state.doc) return;
    var id = state.doc.id;
    $('sheet').hidden = true;
    toast('Downloading the latest version…');
    remote.call('doc', { id: id }).then(function (doc) { return store.putDoc(doc); }).then(function (rec) {
      if (!state.doc || state.doc.id !== id) return;
      var wasPlaying = state.playing;
      speaker.stop(true);
      showDoc(rec).then(function () { toast('Updated.'); if (wasPlaying) speaker.play(); });
    }, function (err) { toast(err.code === 'OFFLINE' ? 'No signal. The saved copy still plays.' : err.message); });
  };
  $('removeDoc').onclick = function () {
    if (!state.doc) return;
    if (!window.confirm('Remove “' + state.doc.title + '” from this phone? It stays in Google Docs.')) return;
    var id = state.doc.id;
    $('sheet').hidden = true;
    stopReading();
    if (lsGet(LS.last) === id) lsSet(LS.last, null);
    store.deleteDoc(id).then(function () { go('#library'); });
  };
  $('forgetKey').onclick = function () {
    if (!window.confirm('Disconnect this phone? Saved Docs are removed from the phone too. You will need your link to connect again.')) return;
    $('sheet').hidden = true;
    stopReading();
    store.listDocs().then(function (docs) { return Promise.all(docs.map(function (d) { return store.deleteDoc(d.id); })); }).then(function () {
      [LS.key, LS.last, LS.list, LS.tab].forEach(function (k) { lsSet(k, null); });
      go('#');
      route();
    });
  };

  /* ------------------------------------------------ install tip + updates ------------------------------------------------ */

  var installEvt = null;
  /** '' (no tip), 'ios', 'android-install' (Chrome offered its prompt) or 'android-hint'. Never inside the installed app. */
  function installTip(env) {
    if (env.standalone || env.dismissed) return '';
    var ua = env.ua || '';
    var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.touch);
    if (ios) return 'ios';
    if (/Android/.test(ua)) return env.canPrompt ? 'android-install' : 'android-hint';
    return '';
  }
  window.DRInstallTip = installTip;

  function drawTip() {
    var old = $('tip'); if (old) old.parentNode.removeChild(old);
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    var kind = installTip({ standalone: standalone, dismissed: lsGet(LS.tipOff) === '1', ua: navigator.userAgent,
                            canPrompt: !!installEvt, touch: (navigator.maxTouchPoints || 0) > 1 });
    if (!kind) return;
    var text = kind === 'ios' ? 'Install: tap Share, then Add to Home Screen. Paste your link once after installing.'
      : kind === 'android-install' ? 'Install Doc Reader on this phone.'
      : 'Install: tap the ⋮ menu, then Install app (or Add to Home screen).';
    var div = document.createElement('div');
    div.id = 'tip'; div.setAttribute('role', 'note'); div.setAttribute('data-kind', kind);
    div.innerHTML = '<span>' + esc(text) + '</span>' + (kind === 'android-install' ? '<button type="button" class="btn primary" id="installBtn">Install</button>' : '') +
      '<button type="button" class="x" aria-label="Hide this tip">&#x2715;</button>';
    div.hidden = state.screen === 'reader';
    $('bar').insertAdjacentElement('afterend', div);
    div.querySelector('.x').onclick = function () { lsSet(LS.tipOff, '1'); div.parentNode.removeChild(div); };
    var ib = div.querySelector('#installBtn');
    if (ib) ib.onclick = function () { var e = installEvt; installEvt = null; e.prompt(); e.userChoice.then(drawTip, drawTip); };
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; drawTip(); });
  window.addEventListener('appinstalled', function () { installEvt = null; lsSet(LS.tipOff, '1'); drawTip(); });

  function showUpdate(worker) {
    var b = $('banner');
    b.textContent = 'New version available. Tap to refresh.';
    b.hidden = false;
    b.onclick = function () {
      if (state.playing) speaker.pause();
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (!reloading) { reloading = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (nw) nw.addEventListener('statechange', function () { if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(nw); });
      });
    }).catch(function () { /* no offline support, the app still works with signal */ });
  }

  /* ------------------------------------------------ start ------------------------------------------------ */

  window.addEventListener('pagehide', function () { if (state.doc) store.putPos(state.doc.id, T.makePos(state.sentences, state.cur)); });
  takeKeyFromUrl();
  connect();
  drawTip();
  route();
  window.DRApp = { state: state, speaker: speaker, store: store };
}());
