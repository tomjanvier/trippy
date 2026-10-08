import type { Env } from "../env";

/**
 * Rate-limit "fixed window" adossé à KV.
 * Fail-open si KV est indisponible (ne jamais bloquer le trafic légitime
 * à cause d'une panne du compteur).
 */
export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ ok: boolean; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(now / windowSec);
  const kvKey = `rl:${key}:${windowId}`;
  try {
    const cur = Number((await env.SESSIONS.get(kvKey)) ?? 0);
    if (cur >= limit) return { ok: false, retryAfter: (windowId + 1) * windowSec - now };
    await env.SESSIONS.put(kvKey, String(cur + 1), { expirationTtl: windowSec * 2 });
    return { ok: true, retryAfter: 0 };
  } catch {
    return { ok: true, retryAfter: 0 };
  }
}
