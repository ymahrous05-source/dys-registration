// Delta Youth Sanad — registration form service worker
// Purpose: cache the app shell (this page + icon + manifest) so the FORM ITSELF
// still opens with no internet connection. Actual submissions still need a live
// connection to reach the Apps Script backend — see the offline queue logic in
// dys_form.html, which stores a submission locally and resends it automatically
// once the connection comes back.

const CACHE_NAME = "dys-form-shell-v2";
const APP_SHELL = [
  "./dys_form.html",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Never intercept calls to the Apps Script backend — those must always hit the network.
  if (req.url.includes("script.google.com")) return;

  // Never intercept the admin dashboard — it's an admin tool, not part of the
  // offline-capable public form, and it must always show the very latest
  // code + data. Caching it here was the actual cause of admins seeing
  // stale/broken dashboards after an update even on a "fresh" page load.
  if (req.url.includes("dys_dashboard.html")) return;

  // Cache-first for same-origin app-shell files, network fallback for everything else.
  if (req.method === "GET") {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res.ok && req.url.startsWith(self.location.origin)) {
              const resClone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
            }
            return res;
          })
          .catch(() => cached); // if totally offline and not cached, this just fails gracefully
      })
    );
  }
});
