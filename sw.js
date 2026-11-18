/**
 * QRShare service worker: offline app shell.
 *
 * Only same-origin GET requests for the files below are served from cache.
 * Signaling (PeerJS) and peer-to-peer traffic never pass through here.
 * Bump VERSION whenever any shell file changes; the new cache installs in the
 * background and takes over after the user accepts the "new version" prompt.
 */
const VERSION = 'qrshare-v2.0.2';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/app.css',
  'assets/fonts/schibsted-grotesk-latin.woff2',
  'assets/fonts/schibsted-grotesk-latin-ext.woff2',
  'assets/icons/logo.svg',
  'assets/icons/icon-192.png',
  'assets/icons/apple-touch-icon.png',
  'assets/vendor/peerjs-1.5.5.min.js',
  'assets/vendor/qrcode-generator-1.4.4.js',
  'assets/js/theme-init.js',
  'assets/js/app.js',
  'assets/js/config.js',
  'assets/js/room.js',
  'assets/js/transfer.js',
  'assets/js/chat.js',
  'assets/js/clipboard.js',
  'assets/js/emitter.js',
  'assets/js/util.js',
  'assets/js/ui/dom.js',
  'assets/js/ui/icons.js',
  'assets/js/ui/toast.js',
  'assets/js/ui/dialog.js',
  'assets/js/ui/qr.js',
  'assets/js/ui/scanner.js',
  'assets/js/views/transfers.js',
  'assets/js/views/chat.js',
  'assets/js/views/people.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('qrshare-') && k !== VERSION).map((k) => caches.delete(k)))));
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Cache first keeps HTML and scripts on the same version. Deploys arrive through a new
    // sw.js (the browser re-checks it on every navigation) and the in-app "Reload" prompt.
    event.respondWith(caches.match('index.html', { cacheName: VERSION }).then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(caches.match(req, { cacheName: VERSION, ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
