import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { assertTripAccess, newShareToken } from "../db/client";
import { userIdOf } from "../lib/access";
import { cachedJson } from "../lib/cache";
import { err, readJson } from "../lib/http";
import {
  checkinCreateSchema,
  entryCreateSchema,
  entryPatchSchema,
  hasPayload,
  journeyCreateSchema,
  journeyPatchSchema,
  journeyPhotoCreateSchema,
  journeyPhotoPatchSchema,
} from "../lib/journey";
import { fetchInstagramOEmbed, parseInstagramUrl } from "../photos/instagram";
import { assertUploadable, photoKey, putPhoto } from "../storage/r2";
import { fmtIssues } from "../lib/validate";

export interface JourneyRow {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  is_public: number;
  public_token: string | null;
}

interface JournalPhotoRow {
  id: number;
  source: string;
  r2_key: string | null;
  external_url: string | null;
  thumbnail_url: string | null;
  caption: string | null;
  lat: number | null;
  lng: number | null;
  author: string | null;
}

async function loadJourney(db: D1Database, id: number, userId: number | null): Promise<JourneyRow | null> {
  const j = await db.prepare("SELECT * FROM journeys WHERE id = ?").bind(id).first<JourneyRow>();
  if (!j) return null;
  if (j.user_id === userId) return j;
  if (userId === null) return null;
  const m = await db.prepare("SELECT 1 AS ok FROM journey_members WHERE journey_id = ? AND user_id = ?").bind(id, userId).first<{ ok: number }>();
  return m ? j : null;
}

const journeysApi = new Hono<{ Bindings: Env }>();

// ---------- liste / CRUD ----------
journeysApi.get("/journeys", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { results } = await c.env.DB.prepare(
    `SELECT j.*, (SELECT COUNT(*) FROM journey_photos p WHERE p.journey_id = j.id) AS photos_count,
            (SELECT COUNT(*) FROM journey_entries e WHERE e.journey_id = j.id) AS entries_count
     FROM journeys j LEFT JOIN journey_members m ON m.journey_id = j.id AND m.user_id = ?
     WHERE j.user_id = ? OR m.user_id IS NOT NULL ORDER BY COALESCE(j.started_at, j.created_at) DESC LIMIT 200`,
  ).bind(user.id, user.id).all();
  return c.json({ journeys: results });
});

journeysApi.post("/journeys", requireAuth, async (c) => {
  const user = c.get("user")!;
  const parsed = journeyCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  // Un voyage ne peut être lié que si l'utilisateur y a accès.
  if (b.trip_ids?.length) {
    const placeholders = b.trip_ids.map(() => "?").join(",");
    const allowed = await c.env.DB.prepare(
      `SELECT id FROM trips WHERE id IN (${placeholders}) AND (user_id = ? OR id IN (SELECT trip_id FROM trip_members WHERE user_id = ?))`,
    ).bind(...b.trip_ids, user.id, user.id).all<{ id: number }>();
    if ((allowed.results ?? []).length !== b.trip_ids.length) return err(c, "trip_not_accessible", 403);
  }
  const res = await c.env.DB.prepare(
    "INSERT INTO journeys (user_id, title, description, started_at, ended_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(user.id, b.title, b.description ?? null, b.started_at ?? null, b.ended_at ?? null).run();
  const journeyId = Number(res.meta.last_row_id);
  if (b.trip_ids?.length) {
    await c.env.DB.batch(
      b.trip_ids.map((t, i) => c.env.DB.prepare("INSERT OR IGNORE INTO journey_trips (journey_id, trip_id, sort_order) VALUES (?, ?, ?)").bind(journeyId, t, i)),
    );
  }
  return c.json({ journey: await c.env.DB.prepare("SELECT * FROM journeys WHERE id = ?").bind(journeyId).first() }, 200);
});

journeysApi.get("/journeys/:id", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  const j = await loadJourney(c.env.DB, id, uid);
  if (!j) return err(c, "not_found", 404);
  const db = c.env.DB;
  const batch = await db.batch([
    db.prepare("SELECT * FROM journey_entries WHERE journey_id = ? ORDER BY entry_date, sort_order, id").bind(id),
    db.prepare("SELECT * FROM journey_checkins WHERE journey_id = ? ORDER BY checked_in_at, id").bind(id),
    db.prepare("SELECT * FROM journey_photos WHERE journey_id = ? ORDER BY sort_order, id").bind(id),
    db.prepare("SELECT trip_id FROM journey_trips WHERE journey_id = ? ORDER BY sort_order").bind(id),
  ]);
  return c.json({
    journey: j,
    entries: batch[0]!.results,
    checkins: batch[1]!.results,
    photos: batch[2]!.results,
    trip_ids: (batch[3]!.results as unknown as { trip_id: number }[]).map((r) => r.trip_id),
  });
});

journeysApi.patch("/journeys/:id", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  const j = await loadJourney(c.env.DB, id, uid);
  if (!j) return err(c, "not_found", 404);
  if (j.user_id !== uid) return err(c, "forbidden", 403);
  const parsed = journeyPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const cols = ["title", "description", "status", "started_at", "ended_at", "is_public"] as const;
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const col of cols) {
    const v = (b as Record<string, unknown>)[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v as string | number | null);
    }
  }
  if (sets.length) {
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    await c.env.DB.prepare(`UPDATE journeys SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  }
  return c.json({ journey: await c.env.DB.prepare("SELECT * FROM journeys WHERE id = ?").bind(id).first() });
});

journeysApi.delete("/journeys/:id", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  const j = await loadJourney(c.env.DB, id, uid);
  if (!j) return err(c, "not_found", 404);
  if (j.user_id !== uid) return err(c, "forbidden", 403);
  const keys = (await c.env.DB.prepare("SELECT r2_key FROM journey_photos WHERE journey_id = ? AND r2_key IS NOT NULL").bind(id).all<{ r2_key: string }>())
    .results.map((r) => r.r2_key);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM journey_photos WHERE journey_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM journey_entries WHERE journey_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM journey_checkins WHERE journey_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM journey_trips WHERE journey_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM journey_members WHERE journey_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM journeys WHERE id = ?").bind(id),
  ]);
  if (keys.length) c.executionCtx.waitUntil(c.env.PHOTOS_BUCKET.delete(keys).catch(() => null));
  return c.json({ ok: true });
});

// ---------- check-ins ----------
journeysApi.post("/journeys/:id/checkins", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const parsed = checkinCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const res = await c.env.DB.prepare(
    `INSERT INTO journey_checkins (journey_id, place_id, name, lat, lng, address, country_code, notes, checked_in_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, b.place_id ?? null, b.name, b.lat ?? null, b.lng ?? null, b.address ?? null, b.country_code ?? null, b.notes ?? null, b.checked_in_at, b.source ?? "manual").run();
  return c.json({ checkin: await c.env.DB.prepare("SELECT * FROM journey_checkins WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

journeysApi.delete("/journeys/:id/checkins/:checkinId", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const r = await c.env.DB.prepare("DELETE FROM journey_checkins WHERE id = ? AND journey_id = ?").bind(Number(c.req.param("checkinId")), id).run();
  if ((r.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  return c.json({ ok: true });
});

// ---------- entrées ----------
journeysApi.post("/journeys/:id/entries", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const parsed = entryCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const res = await c.env.DB.prepare(
    "INSERT INTO journey_entries (journey_id, checkin_id, entry_date, title, body, mood, weather) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, b.checkin_id ?? null, b.entry_date, b.title ?? null, b.body ?? null, b.mood ?? null, b.weather ?? null).run();
  return c.json({ entry: await c.env.DB.prepare("SELECT * FROM journey_entries WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

journeysApi.patch("/journeys/:id/entries/:entryId", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const entryId = Number(c.req.param("entryId"));
  if (!(await c.env.DB.prepare("SELECT id FROM journey_entries WHERE id = ? AND journey_id = ?").bind(entryId, id).first())) return err(c, "not_found", 404);
  const parsed = entryPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const cols = ["entry_date", "title", "body", "mood", "weather", "checkin_id", "sort_order"] as const;
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const col of cols) {
    const v = (b as Record<string, unknown>)[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v as string | number | null);
    }
  }
  if (!sets.length) return err(c, "bad_request", 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE journey_entries SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, entryId).run();
  return c.json({ entry: await c.env.DB.prepare("SELECT * FROM journey_entries WHERE id = ?").bind(entryId).first() });
});

journeysApi.delete("/journeys/:id/entries/:entryId", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const r = await c.env.DB.prepare("DELETE FROM journey_entries WHERE id = ? AND journey_id = ?").bind(Number(c.req.param("entryId")), id).run();
  if ((r.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  return c.json({ ok: true });
});

// ---------- photos : upload R2 ----------
journeysApi.post("/journeys/:id/photos", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return err(c, "file_required", 400);
  try {
    assertUploadable(file.type || "image/jpeg", file.size);
  } catch (e) {
    return err(c, String((e as Error).message), 400);
  }
  const key = `journeys/${id}/${crypto.randomUUID()}.${(file.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
  await putPhoto(c.env.PHOTOS_BUCKET, key, file.stream(), file.type || "image/jpeg");
  const lat = form?.get("lat") ? Number(form.get("lat")) : null;
  const lng = form?.get("lng") ? Number(form.get("lng")) : null;
  if ((lat !== null && !Number.isFinite(lat)) || (lng !== null && !Number.isFinite(lng))) return err(c, "bad_latlng", 400);
  const res = await c.env.DB.prepare(
    `INSERT INTO journey_photos (journey_id, entry_id, source, r2_key, original_name, mime_type, size_bytes, caption, lat, lng)
     VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      form?.get("entry_id") ? Number(form.get("entry_id")) : null,
      key,
      file.name.slice(0, 255),
      file.type || null,
      file.size,
      typeof form?.get("caption") === "string" ? String(form.get("caption")).slice(0, 1000) : null,
      lat,
      lng,
    )
    .run();
  return c.json({ photo: await c.env.DB.prepare("SELECT * FROM journey_photos WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

/** Photos externes (Instagram / WordPress) : même table, pas de binaire à nous. */
journeysApi.post("/journeys/:id/photos/external", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const parsed = journeyPhotoCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (b.source === "upload") return err(c, "use_multipart_for_upload", 400);
  if (!hasPayload(b)) return err(c, "external_url_or_r2_key_required", 400);
  if (b.source === "instagram" && b.external_url && !parseInstagramUrl(b.external_url)) return err(c, "bad_instagram_url", 400);
  // Résolution oEmbed pour une miniature et un auteur quand c'est Insta.
  let thumb = b.thumbnail_url ?? null;
  let author = b.author ?? null;
  if (b.source === "instagram" && b.external_url) {
    const embed = await fetchInstagramOEmbed(b.external_url);
    thumb = thumb ?? embed?.thumbnail_url ?? null;
    author = author ?? embed?.author_name ?? null;
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO journey_photos (journey_id, entry_id, source, external_url, thumbnail_url, caption, lat, lng, taken_at, author)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, b.entry_id ?? null, b.source, b.external_url ?? null, thumb, b.caption ?? null, b.lat ?? null, b.lng ?? null, b.taken_at ?? null, author)
    .run();
  return c.json({ photo: await c.env.DB.prepare("SELECT * FROM journey_photos WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

journeysApi.patch("/journeys/:id/photos/:photoId", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const photoId = Number(c.req.param("photoId"));
  if (!(await c.env.DB.prepare("SELECT id FROM journey_photos WHERE id = ? AND journey_id = ?").bind(photoId, id).first())) return err(c, "not_found", 404);
  const parsed = journeyPhotoPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const cols = ["caption", "lat", "lng", "entry_id", "sort_order"] as const;
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const col of cols) {
    const v = (b as Record<string, unknown>)[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v as string | number | null);
    }
  }
  if (!sets.length) return err(c, "bad_request", 400);
  await c.env.DB.prepare(`UPDATE journey_photos SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, photoId).run();
  return c.json({ photo: await c.env.DB.prepare("SELECT * FROM journey_photos WHERE id = ?").bind(photoId).first() });
});

journeysApi.delete("/journeys/:id/photos/:photoId", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const photoId = Number(c.req.param("photoId"));
  const row = await c.env.DB.prepare("SELECT r2_key FROM journey_photos WHERE id = ? AND journey_id = ?").bind(photoId, id).first<{ r2_key: string | null }>();
  if (!row) return err(c, "not_found", 404);
  await c.env.DB.prepare("DELETE FROM journey_photos WHERE id = ?").bind(photoId).run();
  if (row.r2_key) c.executionCtx.waitUntil(c.env.PHOTOS_BUCKET.delete(row.r2_key).catch(() => null));
  return c.json({ ok: true });
});

// ---------- carte du journal (GeoJSON) ----------
journeysApi.get("/journeys/:id/map", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const { results } = await c.env.DB.prepare(
    "SELECT id, source, r2_key, external_url, thumbnail_url, caption, lat, lng, author FROM journey_photos WHERE journey_id = ? AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY id",
  ).bind(id).all<JournalPhotoRow>();
  return c.json({
    type: "FeatureCollection",
    features: results.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lng as number, r.lat as number] },
      properties: {
        id: r.id,
        kind: "journal",
        source: r.source,
        url: r.r2_key ? `/api/journeys/${id}/photos/${r.id}/file` : r.external_url,
        thumbnail: r.thumbnail_url ?? (r.r2_key ? `/api/journeys/${id}/photos/${r.id}/file` : r.external_url),
        caption: r.caption,
        author: r.author,
      },
    })),
  });
});

journeysApi.get("/journeys/:id/photos/:photoId/file", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  if (!(await loadJourney(c.env.DB, id, uid))) return err(c, "not_found", 404);
  const photo = await c.env.DB.prepare("SELECT r2_key, mime_type FROM journey_photos WHERE id = ? AND journey_id = ?")
    .bind(Number(c.req.param("photoId")), id).first<{ r2_key: string | null; mime_type: string | null }>();
  if (!photo?.r2_key) return err(c, "not_found", 404);
  const obj = await c.env.PHOTOS_BUCKET.get(photo.r2_key);
  if (!obj) return err(c, "not_found", 404);
  return new Response(obj.body as ReadableStream, {
    headers: { "content-type": photo.mime_type || "image/jpeg", "cache-control": "private, max-age=3600", etag: `"${obj.etag}"` },
  });
});

// ---------- partage public du journal ----------
journeysApi.post("/journeys/:id/share", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  const j = await loadJourney(c.env.DB, id, uid);
  if (!j || j.user_id !== uid) return err(c, "not_found", 404);
  const token = j.public_token ?? newShareToken();
  await c.env.DB.prepare("UPDATE journeys SET is_public = 1, public_token = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(token, id).run();
  return c.json({ token, url: `${c.env.APP_URL ?? ""}/journey/${token}` });
});

journeysApi.delete("/journeys/:id/share", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const id = Number(c.req.param("id"));
  const j = await loadJourney(c.env.DB, id, uid);
  if (!j || j.user_id !== uid) return err(c, "not_found", 404);
  await c.env.DB.prepare("UPDATE journeys SET is_public = 0, public_token = NULL WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

journeysApi.get("/public/journey/:token", async (c) => {
  const token = c.req.param("token");
  const j = await c.env.DB.prepare("SELECT * FROM journeys WHERE public_token = ? AND is_public = 1").bind(token).first<JourneyRow>();
  if (!j) return err(c, "not_found", 404);
  // Edge-cache 60 s : la clé est l'URL avec son token (capability non devinable).
  return cachedJson(c, 60, async () => {
    const db = c.env.DB;
    const batch = await db.batch([
      db.prepare("SELECT * FROM journey_entries WHERE journey_id = ? ORDER BY entry_date, sort_order, id").bind(j.id),
      db.prepare("SELECT * FROM journey_checkins WHERE journey_id = ? ORDER BY checked_in_at, id").bind(j.id),
      // Volontairement restreint aux photos EXTERNES : les binaires R2 du journal
      // restent privés (un lien public ne doit pas exposer les uploads du compte).
      db.prepare(
        "SELECT id, source, external_url, thumbnail_url, caption, lat, lng, author, taken_at FROM journey_photos WHERE journey_id = ? AND r2_key IS NULL ORDER BY sort_order, id",
      ).bind(j.id),
      db.prepare("SELECT COUNT(*) AS n FROM journey_photos WHERE journey_id = ? AND r2_key IS NOT NULL").bind(j.id),
    ]);
    return c.json({
      journey: { id: j.id, title: j.title, description: j.description, started_at: j.started_at, ended_at: j.ended_at },
      entries: batch[0]!.results,
      checkins: batch[1]!.results,
      photos: batch[2]!.results,
      private_photos_count: (batch[3]!.results[0] as unknown as { n: number }).n,
    });
  });
});

export default journeysApi;