// Keeps the entry app loadable with no connection to the server. Only the app's
// own files are handled — network first, so an updated plugin is picked up as
// soon as the server answers — and never the API: entries made offline wait in
// the page's outbox instead.

const CACHE = 'chiplog-entry';

const SHELL = [
  './',
  'manifest.webmanifest',
  'entry.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'js/main.mjs',
  'js/access.mjs',
  'js/clock.mjs',
  'js/journal.mjs',
  'js/outbox.mjs',
  'js/strokes.mjs',
  'js/components/AccessGate.mjs',
  'js/components/CrewDialog.mjs',
  'js/components/Dialogs.mjs',
  'js/components/Icons.mjs',
  'js/components/ManoeuvrePad.mjs',
  'js/components/NotePanel.mjs',
  'js/components/RecentList.mjs',
  'js/components/SketchPanel.mjs',
  'js/components/StatusHeader.mjs',
  '../icon.svg',
  '../js/api.mjs',
  '../js/auth.mjs',
  '../js/context.mjs',
  '../js/days.mjs',
  '../js/format.mjs',
  '../js/i18n.mjs',
  '../js/ids.mjs',
  '../js/landmarks.mjs',
  '../js/log-lines.mjs',
  '../js/status.mjs',
  '../js/view-memory.mjs',
  '../js/components/common.mjs',
  '../js/components/Timeline.mjs',
  '../vendor/preact-htm.mjs'
];

const shellUrls = () => new Set(SHELL.map((file) => new URL(file, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  url.search = '';
  if (request.method !== 'GET' || !shellUrls().has(url.href)) {
    return;
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(url.href, copy));
        }
        return response;
      })
      .catch(() => caches.match(url.href).then((cached) => cached ?? Response.error()))
  );
});
