// Offline support for the hosted version (GitHub Pages). Not used when opened from file://.
// Network-first so a published update shows up whenever there's internet; falls back to the
// cached copy at the field. tools/build.py stamps BUILD with a content hash on every build.
var BUILD = "dev";
var CACHE = "jingleplayer-" + BUILD;
var FILES = ["./", "manifest.webmanifest", "img/icon-192.png", "img/icon-512.png", "img/icon-180.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("jingleplayer-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  var key = req.mode === "navigate" ? "./" : req;
  e.respondWith(
    // give a flaky field connection 4 s before falling back to the cached copy
    Promise.race([
      fetch(req).then(function (res) {
        if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
        return res;
      }),
      new Promise(function (_, reject) { setTimeout(reject, 4000); })
    ]).catch(function () {
      return caches.match(key).then(function (hit) { return hit || fetch(req); });
    })
  );
});
