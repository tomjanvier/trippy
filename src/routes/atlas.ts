import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import { requireAuth } from "../auth";
import type { Env } from "../env";
import {
  countryCreateSchema,
  countryPatchSchema,
  countryPhotoCreateSchema,
  countryPhotoPatchSchema,
  hasPayload,
  spotCreateSchema,
  spotPatchSchema,
} from "../lib/atlas";
import { isValidLatLng } from "../lib/geo";
import { decodeCursor, encodeCursor, err, getPagination, readJson } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { assertUploadable, putPhoto } from "../storage/r2";
import { fmtIssues } from "../lib/validate";

/**
 * L'atlas — l'API du modèle PAR PAYS.
 *
 * Monté sur `/api/atlas`. Tout est strictement privé : chaque route résout le
 * propriétaire via `requireOwned` et répond 404 (et non 403) si l'id appartient à
 * quelqu'un d'autre, pour ne pas laisser deviner l'existence d'une entrée.
 *
 * Pas de temps réel ici, contrairement aux voyages : une room TripRoom est
 * attachée à un voyage, et l'atlas n'en a pas. L'atlas est une vue
 * personnelle, relue au chargement et rejouée par la file hors ligne du client
 * comme le reste de l'application.
 */

const atlas = new Hono<{ Bindings: Env }>();

// -------------------------------------------------------------- types de lignes

export interface CountryRow {
  id: number;
  user_id: number;
  iso_n3: number;
  visited_from: string | null;
  visited_to: string | null;
  visits: number;
  note: string | null;
  story: string | null;
  created_at: string;
  updated_at: string;
}

/** Colonnes agrégées ajoutées par `GET /api/atlas` et non stockées. */
export interface CountrySummary extends CountryRow {
  photos_count: number;
  spots_count: number;
  /** Clé R2 de la première photo du pays, pour la vignette de la carte. */
  cover_r2_key: string | null;
}

export interface CountryPhotoRow {
  id: number;
  country_id: number;
  r2_key: string | null;
  external_url: string | null;
  caption: string | null;
  taken_on: string | null;
  lat: number | null;
  lng: number | null;
  sort_order: number;
  created_at: string;
}

export interface SpotRow {
  id: number;
  country_id: number;
  name: string;
  kind: string;
  city: string | null;
  verdict: string | null;
  price_cents: number | null;
  url: string | null;
  lat: number | null;
  lng: number | null;
  visited_on: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------- accès

/**
 * Résout un pays appartenant au compte, ou null. Le `?` sur `user_id` est ce qui
 * fait toute la sécurité de l'atlas : sans lui, un id deviné suffirait à lire et
 * modifier l'atlas d'un autre.
 */
async function requireOwned(
  db: D1Database,
  userId: number,
  rawId: string | undefined,
): Promise<CountryRow | null> {
  const id = Number(rawId);
  if (!Number.isFinite(id)) return null;
  return db
    .prepare("SELECT * FROM countries WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<CountryRow>();
}

/** Même idea pour une ligne enfant, résolue par jointure sur son pays. */
async function ownedChild<T>(
  db: D1Database,
  userId: number,
  table: "country_photos" | "spots",
  childId: number,
): Promise<T | null> {
  return db
    .prepare(
      `SELECT x.* FROM ${table} x
         JOIN countries c ON c.id = x.country_id
        WHERE x.id = ? AND c.user_id = ?`,
    )
    .bind(childId, userId)
    .first<T>();
}

const COUNTRY_COLS = ["visited_from", "visited_to", "visits", "note", "story"] as const;
const SPOT_COLS = [
  "name",
  "kind",
  "city",
  "verdict",
  "price_cents",
  "url",
  "lat",
  "lng",
  "visited_on",
  "notes",
  "sort_order",
] as const;

/**
 * Construit le SET d'un PATCH. Absent = ne pas toucher, `null` = effacer : le
 * `!== undefined` est donc la condition, pas une itération sur la valeur.
 */
function patchSets(cols: readonly string[], body: Record<string, unknown>) {
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const col of cols) {
    const v = body[col] as string | number | null | undefined;
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v);
    }
  }
  return { sets, binds };
}

// ---------------------------------------------------------------------------
// GET /api/atlas — charge utile de la page d'accueil.
//
// Une seule requête. La carte a besoin de TOUS les pays (on ne pagine pas une
// carte du monde), et chaque pays porte ses compteurs de photos et d'adresses
// pour la table des matières. Les agrégats sont donc des sous-requêtes
// corrélées dans le même statement : trois requêtes de plus coûteraient le
// budget de sous-requêtes de la Worker pour rien.
//
// L'ordre est `COALESCE(visited_to, visited_from, created_at)` décroissant, et
// c'est lui qui décide de l'ordre des traits du fil de voyage : la carte et la
// table des matières doivent raconter la même histoire, dans le même sens.
// ---------------------------------------------------------------------------
atlas.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.user_id, c.iso_n3, c.visited_from, c.visited_to, c.visits, c.note, c.story,
            c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM country_photos p WHERE p.country_id = c.id) AS photos_count,
            (SELECT COUNT(*) FROM spots s WHERE s.country_id = c.id) AS spots_count,
            (SELECT p.r2_key FROM country_photos p
              WHERE p.country_id = c.id AND p.r2_key IS NOT NULL
              ORDER BY p.sort_order, p.id LIMIT 1) AS cover_r2_key
       FROM countries c
      WHERE c.user_id = ?
      ORDER BY COALESCE(c.visited_to, c.visited_from, c.created_at) DESC, c.id DESC`,
  )
    .bind(user.id)
    .all<CountrySummary>();

  const totals = results.reduce(
    (a, x) => ({ photos: a.photos + x.photos_count, spots: a.spots + x.spots_count }),
    { photos: 0, spots: 0 },
  );
  return c.json(
    { countries: results, totals: { countries: results.length, photos: totals.photos, spots: totals.spots } },
    200,
    { "cache-control": "private, max-age=15" },
  );
});

/**
 * GET /api/atlas/suggestions — pays déjà rencontrés ailleurs dans l'application.
 *
 * Les `journey_checkins` portent le `country_code` alpha-2 que Nominatim a rendu.
 * On renvoie la liste brute, dédoublonnée, avec la dernière fois où le pays a
 * été rencontré. Le client filtre ceux qu'il possède déjà : il a de toute façon
 * la correspondance alpha-2 ↔ n3 embarquée pour dessiner la carte.
 */
atlas.get("/suggestions", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { results } = await c.env.DB.prepare(
    `SELECT jc.country_code AS code, MAX(jc.checked_in_at) AS last_seen
       FROM journey_checkins jc
       JOIN journeys j ON j.id = jc.journey_id
      WHERE j.user_id = ?
        AND jc.country_code IS NOT NULL
        AND jc.country_code <> ''
      GROUP BY jc.country_code
      ORDER BY last_seen DESC
      LIMIT 100`,
  )
    .bind(user.id)
    .all<{ code: string; last_seen: string | null }>();
  return c.json({ suggestions: results });
});

// ---------------------------------------------------------------------------
// GET /api/atlas/countries — table des matières, paginée par curseur keyset.
// ---------------------------------------------------------------------------
atlas.get("/countries", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { limit } = getPagination(c);
  const cursor = decodeCursor(c.req.query("cursor"));
  const binds: (string | number)[] = [user.id];
  const conds = ["user_id = ?"];
  if (cursor) {
    conds.push(
      "(COALESCE(visited_to, visited_from, created_at) < ? OR (COALESCE(visited_to, visited_from, created_at) = ? AND id < ?))",
    );
    binds.push(cursor.t, cursor.t, cursor.id);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM countries WHERE ${conds.join(" AND ")}
      ORDER BY COALESCE(visited_to, visited_from, created_at) DESC, id DESC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<CountryRow>();
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const last = page[page.length - 1];
  const key = last ? (last.visited_to ?? last.visited_from ?? last.created_at) : null;
  return c.json({
    countries: page,
    nextCursor: hasMore && last && key ? encodeCursor(key, last.id) : null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/atlas/countries — poser un pays sur la carte.
// ---------------------------------------------------------------------------
atlas.post("/countries", requireAuth, async (c) => {
  const user = c.get("user")!;
  const parsed = countryCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO countries (user_id, iso_n3, visited_from, visited_to, visits, note, story)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        user.id,
        b.iso_n3,
        b.visited_from ?? null,
        b.visited_to ?? null,
        b.visits ?? 1,
        b.note ?? null,
        b.story ?? null,
      )
      .run();
    const id = Number(res.meta.last_row_id);
    return c.json({ country: await countryById(c.env.DB, id) });
  } catch {
    // Seule contrainte susceptible de sauter ici : UNIQUE(user_id, iso_n3).
    return err(c, "country_already_added", 409);
  }
});

async function countryById(db: D1Database, id: number): Promise<CountryRow | null> {
  return db.prepare("SELECT * FROM countries WHERE id = ?").bind(id).first<CountryRow>();
}

// ---------------------------------------------------------------------------
// GET /api/atlas/countries/:id — la page d'un pays : récit, photos, adresses.
// ---------------------------------------------------------------------------
atlas.get("/countries/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const country = await requireOwned(c.env.DB, user.id, c.req.param("id"));
  if (!country) return err(c, "not_found", 404);
  const res = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM country_photos WHERE country_id = ? ORDER BY sort_order, id").bind(country.id),
    c.env.DB.prepare("SELECT * FROM spots WHERE country_id = ? ORDER BY sort_order, id").bind(country.id),
  ]);
  return c.json(
    {
      country,
      photos: res[0]!.results as unknown as CountryPhotoRow[],
      spots: res[1]!.results as unknown as SpotRow[],
    },
    200,
    { "cache-control": "private, max-age=15" },
  );
});

// ---------------------------------------------------------------------------
// PATCH /api/atlas/countries/:id
// ---------------------------------------------------------------------------
atlas.patch("/countries/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const country = await requireOwned(c.env.DB, user.id, c.req.param("id"));
  if (!country) return err(c, "not_found", 404);
  const parsed = countryPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const { sets, binds } = patchSets(COUNTRY_COLS, parsed.data as Record<string, unknown>);
  if (!sets.length) return err(c, "bad_request", 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE countries SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, country.id).run();
  return c.json({ country: await countryById(c.env.DB, country.id) });
});

/**
 * DELETE /api/atlas/countries/:id — cascade écrite à la main, comme
 * `DELETE /api/trips/:id`. Les `ON DELETE CASCADE` du schéma sont déclarés mais
 * D1 n'applique les clés étrangères que si le pragma est actif sur la connexion,
 * donc s'y fier laisserait des photos et des adresses orphelines.
 */
atlas.delete("/countries/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const country = await requireOwned(c.env.DB, user.id, c.req.param("id"));
  if (!country) return err(c, "not_found", 404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM country_photos WHERE country_id = ?").bind(country.id),
    c.env.DB.prepare("DELETE FROM spots WHERE country_id = ?").bind(country.id),
    c.env.DB.prepare("DELETE FROM countries WHERE id = ?").bind(country.id),
  ]);
  // Purge R2 hors du chemin de la réponse. Préfixe dédié : les photos de voyage
  // vivent sous `photos/<tripId>/`, jamais sous `atlas/`.
  c.executionCtx.waitUntil(
    (async () => {
      const listed = await c.env.PHOTOS_BUCKET.list({ prefix: `atlas/countries/${country.id}/` }).catch(() => null);
      const keys = listed?.objects.map((o) => o.key) ?? [];
      for (let i = 0; i < keys.length; i += 500) {
        await c.env.PHOTOS_BUCKET.delete(keys.slice(i, i + 500)).catch(() => null);
      }
    })(),
  );
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Photos de pays.
//
// Deux formes sur la même route, parce que la source est aussi variée que les
// photos de voyage (upload direct, ou lien déjà en ligne) :
//   - multipart/form-data → le binaire va en R2 sous atlas/countries/<id>/<uuid>
//   - JSON               → { external_url } ou { r2_key }
//
// `r2_key` en JSON est accepté mais réservé : une clé R2 acceptée depuis le
// client permettrait d'écrire dans le bucket sans passer par l'upload. Le handler
// de l'atlas n'expose donc que le chemin multipart pour écrire.
// ---------------------------------------------------------------------------
atlas.post("/countries/:id/photos", requireAuth, async (c) => {
  const user = c.get("user")!;
  const country = await requireOwned(c.env.DB, user.id, c.req.param("id"));
  if (!country) return err(c, "not_found", 404);

  const isMultipart = (c.req.header("content-type") ?? "").includes("multipart/form-data");
  if (isMultipart) {
    const rl = await rateLimit(c.env, `atlas-upload:${user.id}`, 120, 3600);
    if (!rl.ok) return err(c, "rate_limited", 429);
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
    if ((lat !== null || lng !== null) && !isValidLatLng(lat, lng)) return err(c, "bad_latlng", 400);

    const ext = (file.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "jpg";
    const key = `atlas/countries/${country.id}/${crypto.randomUUID()}.${ext}`;
    await putPhoto(c.env.PHOTOS_BUCKET, key, file.stream(), file.type || "image/jpeg");

    const str = (k: string, max: number): string | null => {
      const v = form?.get(k);
      return typeof v === "string" ? v.trim().slice(0, max) || null : null;
    };
    const res = await c.env.DB.prepare(
      `INSERT INTO country_photos (country_id, r2_key, caption, taken_on, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(country.id, key, str("caption", 1000), str("taken_on", 10), lat, lng)
      .run();
    return c.json({ photo: await photoById(c.env.DB, Number(res.meta.last_row_id)) });
  }

  const parsed = countryPhotoCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  // Un lien externe est le seul payload que le client peut poser en JSON.
  if (!hasPayload({ external_url: parsed.data.external_url })) {
    return err(c, "external_url_required", 400);
  }
  const b = parsed.data;
  const res = await c.env.DB.prepare(
    `INSERT INTO country_photos (country_id, external_url, caption, taken_on, lat, lng, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      country.id,
      b.external_url ?? null,
      b.caption ?? null,
      b.taken_on ?? null,
      b.lat ?? null,
      b.lng ?? null,
      b.sort_order ?? 0,
    )
    .run();
  return c.json({ photo: await photoById(c.env.DB, Number(res.meta.last_row_id)) });
});

async function photoById(db: D1Database, id: number): Promise<CountryPhotoRow | null> {
  return db.prepare("SELECT * FROM country_photos WHERE id = ?").bind(id).first<CountryPhotoRow>();
}

atlas.patch("/photos/:photoId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const photoId = Number(c.req.param("photoId"));
  const parsed = countryPhotoPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const owned = await ownedChild<CountryPhotoRow>(c.env.DB, user.id, "country_photos", photoId);
  if (!owned) return err(c, "not_found", 404);
  const { sets, binds } = patchSets(["caption", "taken_on", "lat", "lng", "sort_order"], parsed.data as Record<string, unknown>);
  if (!sets.length) return err(c, "bad_request", 400);
  await c.env.DB.prepare(`UPDATE country_photos SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, photoId).run();
  return c.json({ photo: await photoById(c.env.DB, photoId) });
});

atlas.delete("/photos/:photoId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const photoId = Number(c.req.param("photoId"));
  const owned = await ownedChild<CountryPhotoRow>(c.env.DB, user.id, "country_photos", photoId);
  if (!owned) return err(c, "not_found", 404);
  await c.env.DB.prepare("DELETE FROM country_photos WHERE id = ?").bind(photoId).run();
  if (owned.r2_key) {
    c.executionCtx.waitUntil(c.env.PHOTOS_BUCKET.delete(owned.r2_key).catch(() => null));
  }
  return c.json({ ok: true });
});

/**
 * Binaire R2 d'une photo de pays. Session uniquement : l'atlas n'a pas de lien
 * public. ETag + cache navigateur privé, jamais d'edge — un Cache API sans
 * `vary-cookie` servirait la photo d'un compte à un autre.
 */
atlas.get("/photos/:photoId/file", requireAuth, async (c) => {
  const user = c.get("user")!;
  const photoId = Number(c.req.param("photoId"));
  const owned = await ownedChild<CountryPhotoRow>(c.env.DB, user.id, "country_photos", photoId);
  if (!owned?.r2_key) return err(c, "not_found", 404);
  const obj = await c.env.PHOTOS_BUCKET.get(owned.r2_key);
  if (!obj) return err(c, "not_found", 404);
  if ((c.req.header("if-none-match") ?? "").replaceAll('"', "") === obj.etag) {
    return new Response(null, { status: 304, headers: { etag: `"${obj.etag}"` } });
  }
  return new Response(obj.body as ReadableStream, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
      etag: `"${obj.etag}"`,
    },
  });
});

// ---------------------------------------------------------------------------
// Bonnes adresses — CRUD, même formalisme que les pays.
// ---------------------------------------------------------------------------
atlas.post("/countries/:id/spots", requireAuth, async (c) => {
  const user = c.get("user")!;
  const country = await requireOwned(c.env.DB, user.id, c.req.param("id"));
  if (!country) return err(c, "not_found", 404);
  const parsed = spotCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const res = await c.env.DB.prepare(
    `INSERT INTO spots (country_id, name, kind, city, verdict, price_cents, url, lat, lng, visited_on, notes, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      country.id,
      b.name,
      b.kind,
      b.city ?? null,
      b.verdict ?? null,
      b.price_cents ?? null,
      b.url ?? null,
      b.lat ?? null,
      b.lng ?? null,
      b.visited_on ?? null,
      b.notes ?? null,
      b.sort_order ?? 0,
    )
    .run();
  return c.json({ spot: await spotById(c.env.DB, Number(res.meta.last_row_id)) });
});

async function spotById(db: D1Database, id: number): Promise<SpotRow | null> {
  return db.prepare("SELECT * FROM spots WHERE id = ?").bind(id).first<SpotRow>();
}

atlas.patch("/spots/:spotId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const spotId = Number(c.req.param("spotId"));
  const parsed = spotPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const owned = await ownedChild<SpotRow>(c.env.DB, user.id, "spots", spotId);
  if (!owned) return err(c, "not_found", 404);
  const { sets, binds } = patchSets(SPOT_COLS, parsed.data as Record<string, unknown>);
  if (!sets.length) return err(c, "bad_request", 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE spots SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, spotId).run();
  return c.json({ spot: await spotById(c.env.DB, spotId) });
});

atlas.delete("/spots/:spotId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const spotId = Number(c.req.param("spotId"));
  const res = await c.env.DB.prepare(
    "DELETE FROM spots WHERE id = ? AND country_id IN (SELECT id FROM countries WHERE user_id = ?)",
  )
    .bind(spotId, user.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  return c.json({ ok: true });
});

export default atlas;
