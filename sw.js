// Offline support for the travel version (registered by index.html only away from this Mac's
// server). Network first, so changes arrive whenever you're online; when offline, the copy saved
// on the last visit. Page addresses carry ?v=<time>, so they're matched without the query.
const CACHE = 'mkxl-travel-v2';

// Everything the travel version uses, saved when this is installed so the first visit is enough.
// (tools/selftest.mjs checks this list against the files: add new pages, styles and scripts here.)
const ASSETS = [
  './', 'index.html', 'sequencer.html', 'lab.html', 'recorder.html',
  'style.css', 'sequencer.css', 'lab.css', 'recorder.css',
  'js/core/devices.js', 'js/core/midiports.js', 'js/core/mode.js', 'js/core/storage.js', 'js/core/topbar.js', 'js/core/transfer.js',
  'js/lab/engine.js', 'js/lab/patch.js', 'js/lab/patchview.js', 'js/lab/ui.js',
  'js/rec/audio.js', 'js/rec/ui.js',
  'js/seq/capture.js', 'js/seq/demo.js', 'js/seq/engine.js', 'js/seq/generate.js', 'js/seq/midifile.js', 'js/seq/model.js',
  'js/seq/stock.js', 'js/seq/testsynth.js', 'js/seq/ui.js',
  'js/xl/aiparams.js', 'js/xl/device.js', 'js/xl/fxdata.js', 'js/xl/korgfile.js', 'js/xl/params.js', 'js/xl/ports.js',
  'js/xl/sound-types.js', 'js/xl/soundlib.js', 'js/xl/soundtype.js', 'js/xl/sysex.js',
];
const key = url => new URL(url, self.registration.scope).pathname;

self.addEventListener('install', e => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(ASSETS.map(async a => { const res = await fetch(a, { cache: 'reload' }); if (res.ok) await cache.put(key(a), res); }));
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k); // older versions
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(key(req.url), res.clone());
      return res;
    } catch {
      const hit = await cache.match(key(req.url), { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('offline and not saved yet');
    }
  })());
});
