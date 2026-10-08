import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import {
  assertTripAccess,
  getShareByToken,
  getShareByTrip,
  getTrip,
  newShareToken,
  type PhotoShareRow,
  type PlaceRow,
} from "../db/client";
import { tripFromDay, userIdOf } from "../lib/access";
import { cachedJson, purgeCache } from "../lib/cache";
import { decodeCursor, encodeCursor, err, getPagination, readJson } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import { dayCreateSchema, fmtIssues, sharePatchSchema, tripCreateSchema, tripPatchSchema } from "../lib/validate";

const trips = new Hono<{ Bindings: Env }>();

// ---------- Liste paginée (keyset sur updated_at + id) ----------
trips.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { limit } = getPagination(c);
  const archived = c.req.query("archived");
  const cursor = decodeCursor(c.req.query("cursor"));
  const conds = ["(t.user_id = ? OR m.user_id = ?)"];
  const binds: (number | string)[] = [user.id, user.id];
  if (archived === "1" || archived === "0") {
    conds.push("t.is_archived = ?");
    binds.push(Number(archived));
  }
  if (cursor) {
    conds.push("(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))");
    binds.push(cursor.t, cursor.t, cursor.id);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT t.*,
       (SELECT COUNT(*) FROM places p WHERE p.trip_id = t.id) AS places_count,
       (SELECT COUNT(*) FROM photo_shares s WHERE s.trip_id = t.id) AS photos_count
     FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
     WHERE ${conds.join(" AND ")} ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
  )
    .bind(user.id, ...binds, limit + 1)
    .all();
  const rows = results as unknown as { id: number; updated_at: string }[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return c.json(
    { trips: page, nextCursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null },
    200,
    { "cache-control": "private, max-age=15" },
  );
});

// ---------- Création (avec pré-création optionnelle des jours) ----------
trips.post("/", requireAuth, async (c) => {
  const user = c.get("user")!;
  const parsed = tripCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const res = await c.env.DB.prepare(
    "INSERT INTO trips (user_id, title, description, start_date, end_date, currency, cover_image) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(user.id, b.title, b.description ?? null, b.start_date ?? null, b.end_date ?? null, b.currency ?? "EUR", b.cover_image ?? null)
    .run();
  const tripId = Number(res.meta.last_row_id);
  if (b.days_count) {
    const stmts = Array.from({ length: b.days_count }, (_, i) =>
      c.env.DB.prepare("INSERT INTO days (trip_id, day_number) VALUES (?, ?)").bind(tripId, i + 1),
    );
    await c.env.DB.batch(stmts);
  }
  const trip = await getTrip(c.env.DB, tripId);
  notifyTrip(c, tripId, { type: "trip.created", tripId });
  return c.json({ trip }, 200);
});

// ---------- Détail (requêtes D1 parallélisées en 1 aller-retour) ----------
trips.get("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return err(c, "not_found", 404);
  const trip = await assertTripAccess(c.env.DB, id, user.id);
  if (!trip) return err(c, "not_found", 404);
  const batchRes = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM days WHERE trip_id = ? ORDER BY day_number").bind(id),
    c.env.DB.prepare("SELECT * FROM places WHERE trip_id = ? ORDER BY id").bind(id),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM photo_shares WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("SELECT token, share_map, share_photos, expires_at FROM share_tokens WHERE trip_id = ?").bind(id),
  ]);
  const daysRes = batchRes[0]!;
  const placesRes = batchRes[1]!;
  const sharesRes = batchRes[2]!;
  const shareRes = batchRes[3]!;
  const share = shareRes.results[0] as unknown as { token: string } | undefined;
  return c.json(
    {
      trip,
      days: daysRes.results,
      places: placesRes.results as unknown as PlaceRow[],
      photo_shares_count: (sharesRes.results[0] as unknown as { n: number }).n,
      // Token visible uniquement par le propriétaire.
      share: trip.user_id === user.id && share ? share : null,
    },
    200,
    { "cache-control": "private, max-age=15" },
  );
});

// ---------- Mise à jour (is_archived réservé au propriétaire) ----------
trips.patch("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, id, user.id);
  if (!trip) return err(c, "not_found", 404);
  const parsed = tripPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (b.is_archived !== undefined && trip.user_id !== user.id) return err(c, "forbidden", 403);
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  const push = (col: string, v: string | number | null | undefined) => {
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v);
    }
  };
  push("title", b.title);
  push("description", b.description);
  push("start_date", b.start_date);
  push("end_date", b.end_date);
  push("currency", b.currency);
  push("cover_image", b.cover_image);
  if (b.is_archived !== undefined) {
    sets.push("is_archived = ?");
    binds.push(b.is_archived);
  }
  if (!sets.length) return err(c, "bad_request", 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE trips SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  notifyTrip(c, id, { type: "trip.updated", tripId: id });
  return c.json({ trip: await getTrip(c.env.DB, id) });
});

// ---------- Suppression (propriétaire ; objets R2 nettoyés en arrière-plan) ----------
trips.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, id, user.id);
  if (!trip || trip.user_id !== user.id) return err(c, "not_found", 404);
  // Suppression explicite (ne dépend pas des ON DELETE CASCADE : D1/SQLite
  // n'applique les FK que si le pragma est actif sur la connexion).
  // db.batch() = atomique (tout ou rien).
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM photo_shares WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM photos WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM budget_item_members WHERE budget_item_id IN (SELECT id FROM budget_items WHERE trip_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM budget_items WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM packing_items WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM todo_items WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM todo_category_assignees WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM reservations WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM day_accommodations WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM day_assignments WHERE place_id IN (SELECT id FROM places WHERE trip_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM day_assignments WHERE day_id IN (SELECT id FROM days WHERE trip_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM place_tags WHERE place_id IN (SELECT id FROM places WHERE trip_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM places WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM days WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM share_tokens WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM trip_members WHERE trip_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(id),
  ]);
  c.executionCtx.waitUntil(
    (async () => {
      const listed = await c.env.PHOTOS_BUCKET.list({ prefix: `photos/${id}/` }).catch(() => null);
      const keys = listed?.objects.map((o) => o.key) ?? [];
      for (let i = 0; i < keys.length; i += 500) {
        await c.env.PHOTOS_BUCKET.delete(keys.slice(i, i + 500)).catch(() => null);
      }
    })(),
  );
  notifyTrip(c, id, { type: "trip.deleted", tripId: id });
  return c.json({ ok: true });
});

// ---------- Jours ----------
trips.get("/:id/days", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, id, user.id))) return err(c, "not_found", 404);
  const { results } = await c.env.DB.prepare("SELECT * FROM days WHERE trip_id = ? ORDER BY day_number").bind(id).all();
  return c.json({ days: results });
});

trips.post("/:id/days", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, id, user.id))) return err(c, "not_found", 404);
  const parsed = dayCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  let n = parsed.data.day_number;
  if (n === undefined) {
    const max = await c.env.DB.prepare("SELECT MAX(day_number) AS m FROM days WHERE trip_id = ?").bind(id).first<{ m: number | null }>();
    n = (max?.m ?? 0) + 1;
  }
  try {
    const res = await c.env.DB.prepare("INSERT INTO days (trip_id, day_number, date, title, notes) VALUES (?, ?, ?, ?, ?)")
      .bind(id, n, parsed.data.date ?? null, parsed.data.title ?? null, parsed.data.notes ?? null)
      .run();
    const day = await c.env.DB.prepare("SELECT * FROM days WHERE id = ?").bind(Number(res.meta.last_row_id)).first();
    notifyTrip(c, id, { type: "day.created", tripId: id });
    return c.json({ day }, 200);
  } catch {
    return err(c, "day_number_taken", 409);
  }
});

// ---------- Partage public ----------
trips.post("/:id/share", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, id, user.id);
  if (!trip || trip.user_id !== user.id) return err(c, "not_found", 404);
  const token = newShareToken();
  await c.env.DB.prepare("DELETE FROM share_tokens WHERE trip_id = ?").bind(id).run();
  await c.env.DB.prepare("INSERT INTO share_tokens (trip_id, token) VALUES (?, ?)").bind(id, token).run();
  return c.json({ token, url: `${c.env.APP_URL ?? ""}/shared/${token}` });
});

trips.get("/:id/share", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, id, user.id);
  if (!trip || trip.user_id !== user.id) return err(c, "not_found", 404);
  const share = await getShareByTrip(c.env.DB, id);
  if (!share) return err(c, "not_found", 404);
  return c.json({ share });
});

trips.patch("/:id/share", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, id, user.id);
  if (!trip || trip.user_id !== user.id) return err(c, "not_found", 404);
  const existing = await getShareByTrip(c.env.DB, id);
  if (!existing) return err(c, "not_found", 404);
  const parsed = sharePatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (b.expires_at) {
    const t = new Date(b.expires_at).getTime();
    if (!Number.isFinite(t) || t < Date.now() || t > Date.now() + 366 * 86400_000) {
      return err(c, "bad_expires_at", 400);
    }
  }
  await c.env.DB.prepare("UPDATE share_tokens SET share_map = ?, share_photos = ?, expires_at = ? WHERE trip_id = ?")
    .bind(b.share_map ?? existing.share_map, b.share_photos ?? existing.share_photos, b.expires_at ?? existing.expires_at, id)
    .run();
  await purgeCache(c, `${new URL(c.req.url).origin}/api/shared/${existing.token}`);
  return c.json({ share: await getShareByTrip(c.env.DB, id) });
});

trips.delete("/:id/share", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, id, user.id);
  if (!trip || trip.user_id !== user.id) return err(c, "not_found", 404);
  const existing = await getShareByTrip(c.env.DB, id);
  await c.env.DB.prepare("DELETE FROM share_tokens WHERE trip_id = ?").bind(id).run();
  if (existing) await purgeCache(c, `${new URL(c.req.url).origin}/api/shared/${existing.token}`);
  return c.json({ ok: true });
});

// ---------- Carte unifiée : photo_shares géolocalisés -> GeoJSON ----------
// Auth : JWT vérifié (via optionalAuth global) + accès voyage, OU ?share=<token>
// avec share_photos=1. Les réponses tokenisées sont edge-cachées 30 s
// (clé = URL complète, donc pas de fuite entre liens) ; les réponses
// cookie ne le sont jamais (Cache API sans vary-cookie fuirait entre users).
trips.get("/:id/map-photos", async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!Number.isFinite(tripId)) return err(c, "not_found", 404);
  const shareParam = c.req.query("share");
  let viaShare: string | null = null;
  if (shareParam) {
    const row = await getShareByToken(c.env.DB, shareParam);
    if (!row || row.trip_id !== tripId || !row.share_photos) return err(c, "unauthorized", 401);
    viaShare = shareParam;
  } else {
    const uid = userIdOf(c);
    if (!uid || !(await assertTripAccess(c.env.DB, tripId, uid))) return err(c, "unauthorized", 401);
  }

  const build = async () => {
    const raw = (c.req.query("sources") || "all").split(",").map((s) => s.trim().toLowerCase());
    const ALL = ["upload", "instagram", "wordpress"] as const;
    const wanted = raw.includes("all") || raw.includes("trip") ? [...ALL] : raw.filter((s): s is (typeof ALL)[number] => (ALL as readonly string[]).includes(s));
    const list = wanted.length ? wanted : [...ALL];
    const placeholders = list.map(() => "?").join(",");
    const { results } = await c.env.DB.prepare(
      `SELECT id, source, url, thumbnail_url, caption, lat, lng, author, taken_at, place_id
       FROM photo_shares WHERE trip_id = ? AND source IN (${placeholders}) AND lat IS NOT NULL AND lng IS NOT NULL
       ORDER BY id DESC LIMIT 2000`,
    ).bind(tripId, ...list).all<PhotoShareRow>();
    return c.json(
      {
        type: "FeatureCollection",
        features: results.map((r) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [r.lng, r.lat] },
          properties: { id: r.id, kind: "photo", source: r.source, url: r.url, thumbnail: r.thumbnail_url, caption: r.caption, author: r.author, place_id: r.place_id, taken_at: r.taken_at },
        })),
      },
      200,
      viaShare ? {} : { "cache-control": "private, max-age=30" },
    );
  };
  return viaShare ? cachedJson(c, 30, build) : build();
});

export default trips;
export { tripFromDay };
