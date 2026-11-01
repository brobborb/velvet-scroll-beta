/* Velvet Scroll service worker: makes the site installable and lets it open offline.
   - Pages: network first (so updates arrive straight away), the saved copy when offline.
   - The site's own files and fonts: served from the saved copy, refreshed in the background.
   - Version-numbered libraries from the CDNs (JSZip, PDF.js, pdf-lib): saved once, served from the copy.
   Books never pass through here: they live in the browser's own database on this device.
   Large downloads (natural voices, text-recognition data, the promo video) are left alone. */
const VERSION = 'vs-app-1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'donate.js', 'lib/qrcode.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'];
const LIBS = /^https:\/\/(cdnjs\.cloudflare\.com\/ajax\/libs\/|cdn\.jsdelivr\.net\/npm\/(pdfjs-dist|pdf-lib)@)/;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('vs-app-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function fromNetwork(req, key){
  const res = await fetch(req); if(res && (res.ok || res.type === 'opaque')){ const c = await caches.open(VERSION); c.put(key || req, res.clone()); } return res;
}
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if(req.method !== 'GET') return;
  const same = url.origin === location.origin;
  if(req.mode === 'navigate' && same){
    // the app page: try the network, fall back to the saved copy (ignoring ?source=… and #…)
    e.respondWith(fromNetwork(req).catch(async () => (await caches.match(req, {ignoreSearch:true})) || (await caches.match('index.html')) || Response.error()));
    return;
  }
  if(same){
    if(/\.(mp4|webm)$/.test(url.pathname) || req.headers.has('range')) return;
    e.respondWith(caches.match(req).then(hit => { const net = fromNetwork(req).catch(() => hit); return hit || net; }));
    return;
  }
  if(LIBS.test(req.url)){ e.respondWith(caches.match(req).then(hit => hit || fromNetwork(req))); return; }
  if(FONTS.test(req.url)){ e.respondWith(caches.match(req).then(hit => { const net = fromNetwork(req).catch(() => hit); return hit || net; })); return; }
});
