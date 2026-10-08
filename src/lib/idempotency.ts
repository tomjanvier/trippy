import type { Next } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { AppContext } from "./http";

const MAX_STORED_BYTES = 8192;
const IN_FLIGHT = 0;

interface IdemRow {
  status: number;
  body: string;
}

/**
 * Rejeu `X-Idempotency-Key` (le client offline-first renvoie ses mutations avec
 * cette clé : un retry ne doit jamais double-appliquer).
 *
 * La clé est **réservée avant** le traitement (`status = 0`), pas écrite après :
 * sans cela deux requêtes identiques simultanées passent toutes les deux la
 * lecture et appliquent l'effet deux fois. Si la clé est déjà en cours, on répond
 * 425 (Too Early) et le client réessaiera ; si elle est terminée, on rejoue la
 * réponse mémorisée.
 */
export async function idempotency(c: AppContext, next: Next): Promise<Response | void> {
  const key = c.req.header("x-idempotency-key")?.trim();
  const user = c.get("user");
  if (!key || !user || key.length > 128 || !["POST", "PATCH", "DELETE"].includes(c.req.method)) {
    return next();
  }
  const db: D1Database = c.env.DB;
  const expiresAt = `strftime('%Y-%m-%dT%H:%M:%fZ','now', '+1 day')`;

  // 1. Réservation atomique de la clé : le premier arrivé « gagne », un doublon
  //    concurrent perd et suit le chemin de rejeu (ou 425) ci-dessous.
  const claim = await db
    .prepare(
      `INSERT INTO idempotency_keys (key, user_id, status, body, expires_at) VALUES (?, ?, ${IN_FLIGHT}, '', ${expiresAt})
       ON CONFLICT(key) DO NOTHING`,
    )
    .bind(key, user.id)
    .run()
    .catch(() => null);

  if (claim && (claim.meta.changes ?? 0) === 0) {
    const existing = await db
      .prepare("SELECT status, body FROM idempotency_keys WHERE key = ? AND user_id = ?")
      .bind(key, user.id)
      .first<IdemRow>()
      .catch(() => null);
    if (!existing) return next(); // ligne expirée supprimée entre-temps : on traite
    if (existing.status === IN_FLIGHT) {
      // Traitement déjà en cours : le client doit réessayer, pas abandonner.
      return c.json({ error: "idempotent_request_in_flight" }, 425);
    }
    return new Response(existing.body, {
      status: existing.status as 200,
      headers: { "content-type": "application/json", "x-idempotent-replay": "true" },
    });
  }

  await next();
  const res = c.res;
  const ct = res.headers.get("content-type") ?? "";

  if (res.status >= 500) {
    // Échec serveur : on libère la clé pour permettre un nouvel essai.
    c.executionCtx.waitUntil(db.prepare("DELETE FROM idempotency_keys WHERE key = ? AND user_id = ?").bind(key, user.id).run().catch(() => null));
    return;
  }
  if (!res.ok && res.status !== 425) {
    // Refus définitif (400/403/404/409…) : la clé reste consommée, un rejeu
    // renverrait le même refus — inutile de refaire le traitement.
  }
  if (res.ok && ct.includes("application/json")) {
    const clone = res.clone();
    c.executionCtx.waitUntil(
      (async () => {
        const text = await clone.text().catch(() => "");
        if (!text || text.length > MAX_STORED_BYTES) {
          await db.prepare("DELETE FROM idempotency_keys WHERE key = ? AND user_id = ?").bind(key, user.id).run().catch(() => null);
          return;
        }
        await db
          .prepare("UPDATE idempotency_keys SET status = ?, body = ? WHERE key = ? AND user_id = ?")
          .bind(res.status, text, key, user.id)
          .run()
          .catch(() => null);
      })(),
    );
  } else {
    c.executionCtx.waitUntil(db.prepare("DELETE FROM idempotency_keys WHERE key = ? AND user_id = ?").bind(key, user.id).run().catch(() => null));
  }
}
