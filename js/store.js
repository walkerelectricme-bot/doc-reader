/**
 * store.js: what the phone keeps. IndexedDB "doc-reader": docs (whole downloaded docs, so they play with no signal) and
 * pos (reading position per doc). Small settings (key, speed, voice, text size) live in localStorage.
 * If IndexedDB is unavailable (some private modes), it falls back to memory for this visit.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DRStore = factory();
}(this, function () {
  'use strict';
  var DB = 'doc-reader', VER = 1;

  function Store(idb) {
    this.idb = idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    this.dbp = null;
    this.mem = { docs: {}, pos: {} };
  }

  Store.prototype.open_ = function () {
    var self = this;
    if (!this.idb) return Promise.resolve(null);
    if (!this.dbp) {
      this.dbp = new Promise(function (resolve) {
        var req;
        try { req = self.idb.open(DB, VER); } catch (e) { resolve(null); return; }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('pos')) db.createObjectStore('pos', { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      });
    }
    return this.dbp;
  };

  Store.prototype.tx_ = function (store, mode, fn) {
    var self = this;
    return this.open_().then(function (db) {
      if (!db) return fn(null, self.mem[store]); // memory mode: fn returns the value itself
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var os = t.objectStore(store);
        var out;
        var r = fn(os, null);
        if (r && 'onsuccess' in r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  };

  Store.prototype.putDoc = function (doc) {
    var rec = { id: doc.id, title: doc.title, revision: doc.revision || '', paragraphs: doc.paragraphs || [],
                fetched: doc.fetched || new Date().toISOString(), saved: Date.now() };
    return this.tx_('docs', 'readwrite', function (os, mem) { if (!os) { mem[rec.id] = rec; return; } return os.put(rec); })
      .then(function () { return rec; });
  };

  Store.prototype.getDoc = function (id) {
    return this.tx_('docs', 'readonly', function (os, mem) { return os ? os.get(id) : mem[id]; })
      .then(function (r) { return r || null; });
  };

  /** Saved docs without their text: [{id, title, saved, count}], newest first. */
  Store.prototype.listDocs = function () {
    return this.tx_('docs', 'readonly', function (os, mem) {
      return os ? os.getAll() : Object.keys(mem).map(function (k) { return mem[k]; });
    }).then(function (rows) {
      return (rows || []).map(function (d) { return { id: d.id, title: d.title, saved: d.saved, count: (d.paragraphs || []).length }; })
        .sort(function (a, b) { return b.saved - a.saved; });
    });
  };

  Store.prototype.deleteDoc = function (id) {
    var self = this;
    return this.tx_('docs', 'readwrite', function (os, mem) { if (!os) { delete mem[id]; return; } return os['delete'](id); })
      .then(function () { return self.tx_('pos', 'readwrite', function (os, mem) { if (!os) { delete mem[id]; return; } return os['delete'](id); }); });
  };

  Store.prototype.putPos = function (id, pos) {
    var rec = { id: id, pos: pos };
    return this.tx_('pos', 'readwrite', function (os, mem) { if (!os) { mem[id] = rec; return; } return os.put(rec); });
  };

  Store.prototype.getPos = function (id) {
    return this.tx_('pos', 'readonly', function (os, mem) { return os ? os.get(id) : mem[id]; })
      .then(function (r) { return r ? r.pos : null; });
  };

  return { Store: Store };
}));
