/**
 * text.js: pure text helpers (no DOM, no speech). Shared by the app and the node tests.
 *  - splitSentences(text): sentence chunks small enough for phone speech (Android Chrome cuts off long utterances).
 *  - buildSentences(paragraphs): every sentence of a doc with its paragraph number, in reading order.
 *  - makePos / resolvePos: save a reading position and find it again, even after the Doc was edited.
 *  - parseDocId / parseKey: pull a Doc ID out of a pasted link, and the personal key out of a pasted app link.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DRText = factory();
}(this, function () {
  'use strict';

  var MAX_CHUNK = 220;     // characters per spoken chunk; long sentences are split at commas, then at spaces
  var ABBR = ['mr', 'mrs', 'ms', 'dr', 'st', 'sr', 'jr', 'prof', 'rev', 'gen', 'col', 'capt', 'lt', 'sgt', 'gov', 'sen', 'rep',
    'vs', 'etc', 'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'approx', 'no', 'nos', 'vol', 'fig', 'ft', 'in', 'lb', 'lbs', 'oz',
    'mt', 'ave', 'blvd', 'rd', 'hwy', 'apt', 'ste', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
    'nov', 'dec', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun', 'ph', 'amp', 'qty', 'pt', 'pts'];
  var ABBR_SET = {};
  ABBR.forEach(function (a) { ABBR_SET[a] = 1; });

  /** True if the word ending at a period is an abbreviation (so the period does not end the sentence). */
  function isAbbrev(word, next) {
    var w = word.replace(/^[("'\u201c\u2018\[]+/, '');
    var lw = w.toLowerCase().replace(/\.$/, '');
    if (/^(?:[a-z]\.){1,}[a-z]?$/i.test(w + (/\.$/.test(w) ? '' : '.')) && /\./.test(w.slice(0, -1))) return true; // e.g. i.e. U.S.
    if (/^[A-Z]$/.test(lw.toUpperCase()) && /^[A-Z]$/.test(w.replace(/\.$/, ''))) return true; // initials: J. Smith
    if (ABBR_SET[lw]) {
      // "no." / "in." / "sun." are only abbreviations when a number or capital-free word follows
      if (lw === 'no' || lw === 'in' || lw === 'sun' || lw === 'mar' || lw === 'sat' || lw === 'est' || lw === 'co') return /^\d/.test(next || '');
      if (lw === 'etc') return !!next && /^[a-z]/.test(next);
      return true;
    }
    return false;
  }

  /** Split a paragraph into sentences. Keeps the punctuation; trims spaces; never returns empty strings. */
  function splitRaw(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    var out = [];
    var start = 0;
    var re = /([.!?\u2026]+|\.\.\.)(["'\u201d\u2019)\]]*)(\s+|$)/g;
    var m;
    while ((m = re.exec(text))) {
      var end = m.index + m[1].length + m[2].length;
      var before = text.slice(start, m.index);
      var lastWord = (before.split(' ').pop() || '') + (m[1] === '.' ? '.' : '');
      var rest = text.slice(re.lastIndex);
      var next = rest.split(' ')[0] || '';
      if (m[1] === '.' && m[2] === '' && isAbbrev(lastWord, next)) continue;
      // a lowercase continuation after "..." is the same sentence
      if (/^(\.\.\.|\u2026)$/.test(m[1]) && /^[a-z]/.test(next)) continue;
      if (!m[3] && re.lastIndex < text.length) continue;
      var s = text.slice(start, end).trim();
      if (s) out.push(s);
      start = re.lastIndex;
      if (m[0].length === 0) re.lastIndex++;
    }
    var tail = text.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }

  /** Break one too-long sentence into chunks: at ; : , dashes first, then at spaces. */
  function chunk(s, max) {
    max = max || MAX_CHUNK;
    if (s.length <= max) return [s];
    var out = [];
    var rest = s;
    while (rest.length > max) {
      var cut = -1;
      var window = rest.slice(0, max);
      var marks = [/[;:]\s/g, /,\s/g, /\s[\u2013\u2014-]\s/g, /\s/g];
      for (var k = 0; k < marks.length && cut < 0; k++) {
        var re = marks[k], mm, best = -1;
        while ((mm = re.exec(window))) { if (mm.index > max * 0.35) best = mm.index + (k === 3 ? 0 : 1); }
        cut = best;
      }
      if (cut < 0) cut = max; // one enormous "word" (a long link): hard cut
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(function (x) { return x; });
  }

  function splitSentences(text, max) {
    var out = [];
    splitRaw(text).forEach(function (s) { out.push.apply(out, chunk(s, max)); });
    return out;
  }

  /** paragraphs [{t, text, level, n}] -> sentences [{i, p, text}] (i = index in the whole doc, p = paragraph index). */
  function buildSentences(paragraphs, max) {
    var out = [];
    (paragraphs || []).forEach(function (para, p) {
      var parts = para.t === 'h' ? chunk(String(para.text || '').replace(/\s+/g, ' ').trim(), max) : splitSentences(para.text, max);
      parts.forEach(function (text) { if (text) out.push({ i: out.length, p: p, text: text }); });
    });
    return out;
  }

  /** First sentence index of each paragraph (-1 for a paragraph with no sentences). */
  function paragraphStarts(sentences, paraCount) {
    var starts = [];
    for (var p = 0; p < paraCount; p++) starts.push(-1);
    sentences.forEach(function (s) { if (starts[s.p] === -1) starts[s.p] = s.i; });
    return starts;
  }

  /** Where "back one paragraph" goes: the start of this paragraph, or the previous one if we're already at its start. */
  function prevParagraphIndex(sentences, i) {
    if (!sentences.length) return 0;
    i = clamp(i, 0, sentences.length - 1);
    var p = sentences[i].p;
    var j = i;
    while (j > 0 && sentences[j - 1].p === p) j--;
    if (j < i) return j;
    if (j === 0) return 0;
    var pp = sentences[j - 1].p;
    while (j > 0 && sentences[j - 1].p === pp) j--;
    return j;
  }

  /** "Forward one paragraph": the first sentence of the next paragraph (or the last sentence if none). */
  function nextParagraphIndex(sentences, i) {
    if (!sentences.length) return 0;
    i = clamp(i, 0, sentences.length - 1);
    var p = sentences[i].p;
    var j = i;
    while (j < sentences.length && sentences[j].p === p) j++;
    return j < sentences.length ? j : sentences.length - 1;
  }

  function clamp(n, lo, hi) { n = Number(n) || 0; return n < lo ? lo : n > hi ? hi : n; }

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  /** A saved position: the sentence index plus a snippet of its text, so it can be found again after edits. */
  function makePos(sentences, i, total) {
    if (!sentences.length) return { i: 0, p: 0, snip: '', total: 0, at: Date.now() };
    i = clamp(i, 0, sentences.length - 1);
    return { i: i, p: sentences[i].p, snip: norm(sentences[i].text).slice(0, 80), total: sentences.length, at: Date.now() };
  }

  /**
   * Find a saved position in a (possibly re-downloaded, edited) doc. Order of trust:
   *  1. same index and the snippet still matches;  2. the nearest sentence whose text matches the snippet;
   *  3. the same paragraph number's first sentence;  4. the same index, clamped.  Returns a sentence index.
   */
  function resolvePos(sentences, pos) {
    if (!sentences.length || !pos) return 0;
    var n = sentences.length;
    var i = clamp(pos.i, 0, n - 1);
    var snip = pos.snip || '';
    if (!snip) return i;
    if (norm(sentences[i].text).slice(0, 80) === snip) return i;
    var best = -1, bestDist = Infinity;
    for (var j = 0; j < n; j++) {
      var t = norm(sentences[j].text).slice(0, 80);
      if (t === snip || (snip.length >= 20 && t.indexOf(snip.slice(0, 40)) === 0)) {
        var d = Math.abs(j - i);
        if (d < bestDist) { best = j; bestDist = d; }
      }
    }
    if (best >= 0) return best;
    if (typeof pos.p === 'number') {
      for (var k = 0; k < n; k++) if (sentences[k].p >= pos.p) return k;
    }
    return i;
  }

  /** The Doc ID in a pasted link: docs.google.com/document/d/<id>/..., an ?id=<id> link, or a bare ID. '' if none. */
  function parseDocId(s) {
    s = String(s || '').trim();
    var m = /\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '';
  }

  /** The personal key in a pasted app link (…/doc-reader/?k=KEY) or a bare key. '' if none. */
  function parseKey(s) {
    s = String(s || '').trim();
    var m = /[?&#]k=([A-Za-z0-9_-]{16,})/.exec(s);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{32,}$/.test(s) ? s : '';
  }

  /** Rough minutes left at a speed (about 15 characters per second at 1x). */
  function minutesLeft(sentences, i, rate) {
    var chars = 0;
    for (var j = Math.max(0, i); j < sentences.length; j++) chars += sentences[j].text.length + 1;
    return Math.max(0, Math.round(chars / (15 * (rate || 1)) / 60));
  }

  return {
    MAX_CHUNK: MAX_CHUNK, splitSentences: splitSentences, splitRaw: splitRaw, chunk: chunk, buildSentences: buildSentences,
    paragraphStarts: paragraphStarts, prevParagraphIndex: prevParagraphIndex, nextParagraphIndex: nextParagraphIndex,
    makePos: makePos, resolvePos: resolvePos, parseDocId: parseDocId, parseKey: parseKey, minutesLeft: minutesLeft, norm: norm
  };
}));
