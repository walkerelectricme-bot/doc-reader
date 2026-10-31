/**
 * remote.js: talks to the Doc Reader Apps Script server. One POST per call, text/plain JSON (no CORS preflight).
 * Errors come back with a code: OFFLINE (no signal / timeout), BAD_KEY (link not valid), ACCESS (deployment not open to
 * "Anyone"), SETUP, NO_ACCESS, BAD_DOC, or ERROR.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DRRemote = factory();
}(this, function () {
  'use strict';

  function codedError(code, message) { var e = new Error(message); e.code = code; return e; }

  function Remote(url, key, opts) {
    opts = opts || {};
    this.url = url;
    this.key = key;
    this.version = opts.version || '';
    this.fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(typeof window !== 'undefined' ? window : this) : null);
    this.timeoutMs = opts.timeoutMs || 25000;
  }

  Remote.prototype.call = function (fn, args) {
    var self = this;
    if (!this.url) return Promise.reject(codedError('SETUP', 'The app is not connected to its server yet (config.js).'));
    if (!this.key) return Promise.reject(codedError('BAD_KEY', 'Paste your personal Doc Reader link first.'));
    var body = JSON.stringify({ k: this.key, fn: fn, args: args || {}, v: this.version });
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer;
    var p = this.fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body,
      redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    var t = new Promise(function (_, reject) {
      timer = setTimeout(function () { if (ctrl) ctrl.abort(); reject(codedError('OFFLINE', 'No signal (the server did not answer in time).')); }, self.timeoutMs);
    });
    return Promise.race([p, t]).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (txt) {
        var j;
        try { j = JSON.parse(txt); } catch (e) {
          throw codedError('ACCESS', 'The server did not answer as expected. Check the deployment access is "Anyone" (GO-LIVE.md).');
        }
        if (j && j.ok) return j.result;
        var er = (j && j.error) || {};
        throw codedError(er.code || 'ERROR', er.message || 'Something went wrong.');
      });
    }, function (err) {
      clearTimeout(timer);
      if (err && err.code) throw err;
      throw codedError('OFFLINE', 'No signal.');
    });
  };

  return { Remote: Remote, codedError: codedError };
}));
