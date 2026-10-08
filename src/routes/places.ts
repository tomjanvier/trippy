import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { assertTripAccess, getDay, getPlace } from "../db/client";
import { tripFromPlace, userIdOf } from "../lib/access";
import { err, readJson } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import { fmtIssues, placeCreateSchema, placePatchSchema, placesBulkSchema } from "../lib/validate";

/** Opérations collection imbriquées sous /api/trips/:id/places (compat client d'origine). */
export const placesNested = new Hono<{ Bindings: Env }>();

placesNested.get("/:id/places", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, tripId, userIdOf(c));
  if (!trip) return err(c, "not_found", 404);
  const conds = ["trip_id = ?"];
  const binds: (number | string)[] = [tripId];
  const dayId = c.req.query("day_id");
  if (dayId !== undefined) {
    const n = Number(dayId);
    if (!Number.isFinite(n)) return err(c, "bad_day_id", 400);
    // Filtre par assignation (source unique du rattachement jour).
    conds.push("id IN (SELECT place_id FROM day_assignments WHERE day_id = ?)");
    binds.push(n);
  }
  const category = c.req.query("category")?.trim();
  if (category) {
    conds.push("category = ?");
    binds.push(category.slice(0, 80));
  }
  const search = c.req.query("search")?.trim();
  if (search) {
    conds.push("(name LIKE ? OR address LIKE ? OR notes LIKE ?)");
    binds.push(`%${search.slice(0, 80)}%`, `%${search.slice(0, 80)}%`, `%${search.slice(0, 80)}%`);
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM places WHERE ${conds.join(" AND ")} ORDER BY id LIMIT 500`).bind(...binds).all();
  return c.json({ places: results });
});

placesNested.post("/:id/places/bulk", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, tripId, userIdOf(c));
  if (!trip) return err(c, "not_found", 404);
  const parsed = placesBulkSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const input = parsed.data.places;
  // Résolution day_id -> day_number : le front envoie le numéro de jour lisible.
  const dayRows = await c.env.DB.prepare("SELECT id, day_number FROM days WHERE trip_id = ?").bind(tripId).all<{
    id: number;
    day_number: number;
  }>();
  const idByNumber = new Map(dayRows.results.map((d) => [d.day_number, d.id]));
  const validIds = new Set(dayRows.results.map((d) => d.id));
  const stmts = [];
  for (const p of input) {
    let dayId: number | null = null;
    if (typeof p.day_id === "number") {
      // Interprète d'abord comme un numéro de jour, sinon comme un id (compat).
      dayId = idByNumber.get(p.day_id) ?? (validIds.has(p.day_id) ? p.day_id : null);
      if (dayId === null) return err(c, "bad_day_id", 400);
    }
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO places (trip_id, day_id, name, lat, lng, address, category, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(tripId, dayId, p.name, p.lat ?? null, p.lng ?? null, p.address ?? null, p.category ?? null, p.notes ?? null),
    );
  }
  await c.env.DB.batch(stmts); // atomique : tout ou rien
  const { results } = await c.env.DB.prepare("SELECT * FROM places WHERE trip_id = ? ORDER BY id").bind(tripId).all();
  notifyTrip(c, tripId, { type: "place.bulk", tripId, count: input.length });
  return c.json({ inserted: input.length, places: results }, 200);
});

placesNested.post("/:id/places", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, tripId, userIdOf(c));
  if (!trip) return err(c, "not_found", 404);
  const parsed = placeCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (b.day_id !== undefined && b.day_id !== null) {
    const day = await getDay(c.env.DB, b.day_id);
    if (!day || day.trip_id !== tripId) return err(c, "bad_day_id", 400);
  }
  // Le jour n'est plus stocké sur le lieu : il passe par day_assignments
  // (source unique, cf. migration 0004).
  const res = await c.env.DB.prepare(
    "INSERT INTO places (trip_id, name, lat, lng, address, category, notes, image_url, website) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(tripId, b.name, b.lat ?? null, b.lng ?? null, b.address ?? null, b.category ?? null, b.notes ?? null, b.image_url ?? null, b.website ?? null)
    .run();
  const place = await getPlace(c.env.DB, Number(res.meta.last_row_id));
  if (b.day_id) {
    const next = ((await c.env.DB.prepare("SELECT COALESCE(MAX(order_index), -1) AS m FROM day_assignments WHERE day_id = ?").bind(b.day_id).first<{ m: number }>())?.m ?? -1) + 1;
    await c.env.DB.prepare("INSERT INTO day_assignments (day_id, place_id, order_index) VALUES (?, ?, ?)").bind(b.day_id, place!.id, next).run();
  }
  notifyTrip(c, tripId, { type: "place.created", tripId, place });
  return c.json({ place }, 200);
});

/** Opérations membre sous /api/places/:placeId. */
export const placesApi = new Hono<{ Bindings: Env }>();

placesApi.get("/:placeId", requireAuth, async (c) => {
  const resolved = await tripFromPlace(c.env.DB, Number(c.req.param("placeId")), userIdOf(c));
  if (!resolved) return err(c, "not_found", 404);
  return c.json({ place: await getPlace(c.env.DB, resolved.placeId) });
});

placesApi.patch("/:placeId", requireAuth, async (c) => {
  const placeId = Number(c.req.param("placeId"));
  const resolved = await tripFromPlace(c.env.DB, placeId, userIdOf(c));
  if (!resolved) return err(c, "not_found", 404);
  const parsed = placePatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (b.day_id !== undefined && b.day_id !== null) {
    const day = await getDay(c.env.DB, b.day_id);
    if (!day || day.trip_id !== resolved.trip.id) return err(c, "bad_day_id", 400);
  }
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  // `!== undefined` : null est une valeur explicite (« effacer le champ »), pas une absence.
  const push = (col: string, v: string | number | null | undefined) => {
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v);
    }
  };
  push("name", b.name);
  push("lat", b.lat);
  push("lng", b.lng);
  push("address", b.address);
  push("category", b.category);
  push("notes", b.notes);
  push("image_url", b.image_url);
  push("website", b.website);
  if (!sets.length) return err(c, "bad_request", 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE places SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, placeId).run();
  // Rattachement de jour : null = retirer le lieu de tous les jours.
  if (b.day_id !== undefined) {
    await c.env.DB.prepare("DELETE FROM day_assignments WHERE place_id = ?").bind(placeId).run();
    if (b.day_id !== null) {
      const next = ((await c.env.DB.prepare("SELECT COALESCE(MAX(order_index), -1) AS m FROM day_assignments WHERE day_id = ?").bind(b.day_id).first<{ m: number }>())?.m ?? -1) + 1;
      await c.env.DB.prepare("INSERT INTO day_assignments (day_id, place_id, order_index) VALUES (?, ?, ?)").bind(b.day_id, placeId, next).run();
    }
  }
  if (!sets.length) return err(c, "bad_request", 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE places SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, placeId).run();
  const place = await getPlace(c.env.DB, placeId);
  notifyTrip(c, resolved.trip.id, { type: "place.updated", tripId: resolved.trip.id, place });
  return c.json({ place });
});

placesApi.delete("/:placeId", requireAuth, async (c) => {
  const placeId = Number(c.req.param("placeId"));
  const resolved = await tripFromPlace(c.env.DB, placeId, userIdOf(c));
  if (!resolved) return err(c, "not_found", 404);
  // FK : photos.place_id et photo_shares.place_id passent à NULL.
  await c.env.DB.prepare("DELETE FROM places WHERE id = ?").bind(placeId).run();
  notifyTrip(c, resolved.trip.id, { type: "place.deleted", tripId: resolved.trip.id, placeId });
  return c.json({ ok: true });
});
