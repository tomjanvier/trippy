import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { assertTripAccess, getPhoto, getShareByToken } from "../db/client";
import { userIdOf } from "../lib/access";
import { clientIp, err, getPagination, readJson } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import { rateLimit } from "../lib/ratelimit";
import { fmtIssues, photoSharePatchSchema } from "../lib/validate";
import { assertUploadable, photoKey, putPhoto } from "../storage/r2";

/** Toutes les routes imbriquées /api/trips/:id/... liées aux photos. */
export const photosNested = new Hono<{ Bindings: Env }>();

photosNested.post("/:id/photos", requireAuth, async (c) => {
  const rl = await rateLimit(c.env, `upload:${clientIp(c)}`, 60, 60);
  if (!rl.ok) return err(c, "rate_limited", 429);
  const tripId = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, tripId, userIdOf(c));
  if (!trip) return err(c, "not_found", 404);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return err(c, "file_required", 400);
  try {
    assertUploadable(file.type || "image/jpeg", file.size);
  } catch (e) {
    return err(c, String((e as Error).message), 400);
  }
  const lat = form?.get("lat") ? Number(form.get("lat")) : null;
  const lng = form?.get("lng") ? Number(form.get("lng")) : null;
  if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
    return err(c, "bad_latlng", 400);
  }
  const placeId = form?.get("place_id") ? Number(form.get("place_id")) : null;
  const caption = typeof form?.get("caption") === "string" ? String(form.get("caption")).slice(0, 1000) : null;
  const ext = (file.name.split(".").pop() || "jpg").slice(0, 8);
  const key = photoKey(tripId, ext);
  await putPhoto(c.env.PHOTOS_BUCKET, key, file.stream(), file.type || "image/jpeg");
  const res = await c.env.DB.prepare(
    `INSERT INTO photos (trip_id, place_id, r2_key, original_name, file_size, mime_type, caption, lat, lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(tripId, placeId, key, file.name.slice(0, 255), file.size, file.type || null, caption, lat, lng)
    .run();
  const photoId = Number(res.meta.last_row_id);
  const publicUrl = `/api/trips/${tripId}/photos/${photoId}/file`;
  await c.env.DB.prepare(
    `INSERT INTO photo_shares (trip_id, place_id, photo_id, source, url, thumbnail_url, caption, lat, lng)
     VALUES (?, ?, ?, 'upload', ?, ?, ?, ?, ?)`,
  )
    .bind(tripId, placeId, photoId, publicUrl, publicUrl, caption, lat, lng)
    .run();
  notifyTrip(c, tripId, { type: "photo.created", tripId });
  return c.json({ id: photoId, r2_key: key, url: publicUrl }, 200);
});

photosNested.get("/:id/photos", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const { limit } = getPagination(c);
  const { results } = await c.env.DB.prepare(
    "SELECT id, place_id, original_name, file_size, mime_type, caption, lat, lng, taken_at, created_at FROM photos WHERE trip_id = ? ORDER BY id DESC LIMIT ?",
  ).bind(tripId, limit).all();
  return c.json({ photos: results });
});

function etagMatches(c: { req: { header(n: string): string | undefined } }, etag: string): boolean {
  const inm = c.req.header("if-none-match");
  if (!inm) return false;
  return inm.split(",").some((t) => t.trim().replace(/^W\//, "").replaceAll('"', "") === etag);
}

/**
 * Lecture du binaire R2.
 * Auth : session avec accès voyage, OU ?share=<token> (share_photos=1).
 * - via share : edge-cache public 1 h + ETag/304.
 * - via session : cache navigateur privé 1 h + ETag/304 (jamais d'edge partagé).
 * - Range (vidéos) : 206, jamais caché.
 */
photosNested.get("/:id/photos/:photoId/file", async (c) => {
  const tripId = Number(c.req.param("id"));
  const photoId = Number(c.req.param("photoId"));
  const shareParam = c.req.query("share");
  let viaShare = false;
  if (shareParam) {
    const row = await getShareByToken(c.env.DB, shareParam);
    if (!row || row.trip_id !== tripId || !row.share_photos) return err(c, "unauthorized", 401);
    viaShare = true;
  } else if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) {
    return err(c, "unauthorized", 401);
  }
  const photo = await getPhoto(c.env.DB, tripId, photoId);
  if (!photo) return err(c, "not_found", 404);

  const rangeHeader = c.req.header("range");
  if (rangeHeader && !viaShare) {
    // 206 partiel, jamais mis en cache (streaming vidéo).
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    const start = m?.[1] ? Number(m[1]) : 0;
    if (!Number.isFinite(start) || start < 0) return err(c, "bad_range", 400);
    const head = await c.env.PHOTOS_BUCKET.head(photo.r2_key);
    const size = head?.size ?? photo.file_size ?? 0;
    const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, size - 1);
    if (end < start) return err(c, "bad_range", 400);
    const obj = await c.env.PHOTOS_BUCKET.get(photo.r2_key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return err(c, "not_found", 404);
    return new Response(obj.body as ReadableStream, {
      status: 206,
      headers: {
        "content-type": photo.mime_type || "application/octet-stream",
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=3600",
      },
    });
  }

  const cache = viaShare ? caches.default : null;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      const h = new Response(hit.body, hit);
      h.headers.set("x-trek-cache", "HIT");
      return h;
    }
  }
  const obj = await c.env.PHOTOS_BUCKET.get(photo.r2_key);
  if (!obj) return err(c, "not_found", 404);
  const etag = obj.etag;
  if (etagMatches(c, etag)) return new Response(null, { status: 304, headers: { etag: `"${etag}"` } });
  const headers: Record<string, string> = {
    "content-type": photo.mime_type || "application/octet-stream",
    "cache-control": viaShare ? "public, max-age=3600" : "private, max-age=3600",
    etag: `"${etag}"`,
    "accept-ranges": "bytes",
  };
  const res = new Response(obj.body as ReadableStream, { headers });
  if (cache && obj.size <= 5 * 1024 * 1024) {
    c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => null));
  }
  return res;
});

photosNested.delete("/:id/photos/:photoId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  const photoId = Number(c.req.param("photoId"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const photo = await getPhoto(c.env.DB, tripId, photoId);
  if (!photo) return err(c, "not_found", 404);
  await c.env.DB.prepare("DELETE FROM photo_shares WHERE photo_id = ?").bind(photoId).run();
  await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(photoId).run();
  c.executionCtx.waitUntil(c.env.PHOTOS_BUCKET.delete(photo.r2_key).catch(() => null));
  notifyTrip(c, tripId, { type: "photo.deleted", tripId, photoId });
  return c.json({ ok: true });
});

// ---------- photo_shares (overlay carte unifié) ----------
photosNested.get("/:id/photo-shares", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const { limit } = getPagination(c, 200, 500);
  const source = c.req.query("source");
  const { results } =
    source === "instagram" || source === "wordpress" || source === "upload"
      ? await c.env.DB.prepare("SELECT * FROM photo_shares WHERE trip_id = ? AND source = ? ORDER BY id DESC LIMIT ?").bind(tripId, source, limit).all()
      : await c.env.DB.prepare("SELECT * FROM photo_shares WHERE trip_id = ? ORDER BY id DESC LIMIT ?").bind(tripId, limit).all();
  return c.json({ photo_shares: results });
});

photosNested.delete("/:id/photo-shares/:shareId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  const shareId = Number(c.req.param("shareId"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const row = await c.env.DB.prepare("SELECT id FROM photo_shares WHERE id = ? AND trip_id = ?").bind(shareId, tripId).first();
  if (!row) return err(c, "not_found", 404);
  await c.env.DB.prepare("DELETE FROM photo_shares WHERE id = ?").bind(shareId).run();
  notifyTrip(c, tripId, { type: "photo.deleted", tripId, shareId });
  return c.json({ ok: true });
});

/** Déplacement / édition d'une photo épinglée (drag sur la carte, légende). */
photosNested.patch("/:id/photo-shares/:shareId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  const shareId = Number(c.req.param("shareId"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const existing = await c.env.DB.prepare("SELECT id, place_id FROM photo_shares WHERE id = ? AND trip_id = ?")
    .bind(shareId, tripId)
    .first<{ id: number; place_id: number | null }>();
  if (!existing) return err(c, "not_found", 404);
  const parsed = photoSharePatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (b.place_id !== undefined && b.place_id !== null) {
    const place = await c.env.DB.prepare("SELECT id FROM places WHERE id = ? AND trip_id = ?").bind(b.place_id, tripId).first();
    if (!place) return err(c, "bad_place_id", 400);
  }
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (b.lat !== undefined) {
    sets.push("lat = ?");
    binds.push(b.lat);
  }
  if (b.lng !== undefined) {
    sets.push("lng = ?");
    binds.push(b.lng);
  }
  if (b.place_id !== undefined) {
    sets.push("place_id = ?");
    binds.push(b.place_id);
  }
  if (b.caption !== undefined) {
    sets.push("caption = ?");
    binds.push(b.caption);
  }
  if (!sets.length) return err(c, "bad_request", 400);
  await c.env.DB.prepare(`UPDATE photo_shares SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, shareId).run();
  const row = await c.env.DB.prepare("SELECT * FROM photo_shares WHERE id = ?").bind(shareId).first();
  notifyTrip(c, tripId, { type: "photo.updated", tripId, shareId });
  return c.json({ photo_share: row });
});
