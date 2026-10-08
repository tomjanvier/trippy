import type { AppContext } from "./http";

/**
 * GET JSON mis en cache via Cache API (edge), avec revalidation en arrière-plan.
 * La clé inclut l'URL complète (donc le token `?share=` le cas échéant :
 * pas de fuite entre liens de partage).
 */
export async function cachedJson(
  c: AppContext,
  ttlSec: number,
  producer: () => Promise<Response>,
): Promise<Response> {
  const cache = caches.default;
  const key = new Request(c.req.url, { method: "GET" });
  const hit = await cache.match(key).catch(() => null);
  if (hit) {
    const h = new Response(hit.body, hit);
    h.headers.set("x-trek-cache", "HIT");
    return h;
  }
  const res = await producer();
  if (res.ok) {
    const copy = res.clone();
    copy.headers.set("cache-control", `public, max-age=${ttlSec}`);
    c.executionCtx.waitUntil(cache.put(key, copy).catch(() => null));
    res.headers.set("x-trek-cache", "MISS");
    return res;
  }
  return res;
}

/** Invalide le cache edge d'une URL (après mutation). Best-effort. */
export async function purgeCache(c: AppContext, url: string): Promise<void> {
  await caches.default.delete(new Request(url, { method: "GET" })).catch(() => null);
}
