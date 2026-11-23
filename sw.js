// Offline support: after one visit online, the app, the ziti and the face tracker all open with no signal.
const VERSION = 'nippon-0.5.0';
const CORE = [
  './', './index.html', './app.js', './ziti.js', './stage.js', './tracker-worker.js', './take-writer.js', './reader.js', './manifest.webmanifest',
  './three.module.min.js', './GLTFLoader.js', './RoomEnvironment.js', './BufferGeometryUtils.js',
  './icon-180.png', './icon-512.png',
  './ziti.glb', './face_landmarker.task',
  './vendor/mediapipe/vision_bundle.mjs', './vendor/mediapipe/wasm/vision_wasm_internal.js', './vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  './vendor/jszip.min.js', './vendor/pdf.min.js', './vendor/pdf.worker.min.js',
];
const HEAVY = /\.(glb|task|wasm|png)$|\/vendor\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nippon-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // only this app's own files; manga from other sites and recorded takes are never cached here
  if (req.method !== 'GET' || url.origin !== location.origin || req.headers.has('range')) return;
  if (HEAVY.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  // code and pages: fresh when online, cached when not
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))));
});
