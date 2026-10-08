/*
 * Service worker Trippy.
 *
 * Règles :
 * - Navigations : réseau d'abord, repli sur le shell en cache (l'app démarre hors-ligne).
 * - /assets/* (noms hashés) : cache d'abord, immuables par construction.
 * - GET /api/* : réseau d'abord, repli cache → l'utilisateur voit ses données
 *   voyages même sans réseau. La réponse porte `x-trippy-cache` pour le diagnostic.
 * - Écritures (POST/PATCH/DELETE) : JAMAIS interceptées. Elles passent par la file
 *   de mutations du client (IndexedDB) qui les rejoue avec X-Idempotency-Key —
 *   intercepter ici perdrait la clé d'idempotence et le retour d'erreur.
 * - Réponses API dépendantes d'une session : `private` → on ne les met pas dans un
 *   cache partagé par le navigateur (l'API sert déjà `private, max-age`).
 */
const VERSION = "v1";
const SHELL = `trippy-shell-${VERSION}`;
const ASSETS = `trippy-assets-${VERSION}`;
const API = `trippy-api-${VERSION}`;
const API_CACHEABLE = ["/api/health", "/api/auth/me", "/api/trips", "/api/maps/search"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/", "/index.html", "/manifest.webmanifest", "/icon.svg"]))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, ASSETS, API]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

function isCacheableApi(url) {
  return API_CACHEABLE.some((p) => url.pathname === p);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // écritures : file de mutations, pas ici
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tuiles OSM, oEmbed : réseau direct

  // Navigation : réseau d'abord, shell en repli.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cached = await caches.match("/index.html");
          return cached ?? new Response("Hors ligne", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
      })(),
    );
    return;
  }

  // Assets build (hachés) : cache d'abord.
  if (url.pathname.startsWith("/assets/") || url.pathname === "/icon.svg" || url.pathname === "/icon-maskable.svg") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(ASSETS).then((c) => c.put(req, copy)));
        }
        return res;
      })(),
    );
    return;
  }

  // Lectures API : réseau d'abord, repli cache pour les ressources sans Données.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok && isCacheableApi(url) && res.headers.get("cache-control")?.includes("private")) {
            const copy = res.clone();
            event.waitUntil(caches.open(API).then((c) => c.put(req, copy)));
          }
          return res;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response(JSON.stringify({ error: "offline", offline: true }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
      })(),
    );
  }
});
