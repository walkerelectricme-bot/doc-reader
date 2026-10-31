/**
 * sw.js: keeps the app's own files on the phone so it opens with no signal.
 *  - App files are cached by VERSION (tools/build.js stamps it from a hash of the files). A new version installs in the
 *    background and waits; the page shows "New version available. Tap to refresh" and swaps only when tapped.
 *  - Doc text never goes through this cache: server calls are POSTs (always the network) and saved Docs live in IndexedDB.
 */
var VERSION = 'dr-shell-v1.0-1f3b9c5265';
var SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './css/app.css', './js/text.js', './js/speaker.js',
  './js/store.js', './js/remote.js', './js/app.js', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }));
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('dr-shell-') === 0 && k !== VERSION; })
      .map(function (k) { return caches['delete'](k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (ev) {
  if (ev.data && ev.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    ev.respondWith(caches.match('./index.html').then(function (hit) { return hit || fetch(req); }));
    return;
  }
  ev.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || fetch(req); }));
});
