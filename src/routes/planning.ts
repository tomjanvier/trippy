import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { getDay, getPlace, assertTripAccess } from "../db/client";
import { userIdOf } from "../lib/access";
import { err, readJson } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import {
  accommodationCreateSchema,
  reservationCreateSchema,
  reservationPatchSchema,
} from "../lib/contracts";
import { fmtIssues } from "../lib/validate";

/** Un jour et un lieu doivent appartenir au même voyage. */
async function sameTrip(
  db: D1Database,
  tripId: number,
  dayId: number | null | undefined,
  placeId: number | null | undefined,
): Promise<boolean> {
  if (dayId != null) {
    const d = await getDay(db, dayId);
    if (!d || d.trip_id !== tripId) return false;
  }
  if (placeId != null) {
    const p = await getPlace(db, placeId);
    if (!p || p.trip_id !== tripId) return false;
  }
  return true;
}

/** Contrôle d'accès centralisé : l'utilisateur est-il membre du voyage ? */
async function accessTrip(db: D1Database, tripId: number, userId: number | null): Promise<boolean> {
  return (await assertTripAccess(db, tripId, userId)) !== null;
}

/** ---------- réservations ---------- */
export const reservationsNested = new Hono<{ Bindings: Env }>();

reservationsNested.get("/:id/reservations", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, d.day_number, p.name AS place_name FROM reservations r
     LEFT JOIN days d ON d.id = r.day_id LEFT JOIN places p ON p.id = r.place_id
     WHERE r.trip_id = ? ORDER BY COALESCE(d.day_number, 9999), COALESCE(r.reservation_time, ''), r.id`,
  ).bind(tripId).all();
  return c.json({ reservations: results });
});

reservationsNested.post("/:id/reservations", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const parsed = reservationCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (!(await sameTrip(c.env.DB, tripId, b.day_id, b.place_id)) || !(await sameTrip(c.env.DB, tripId, b.end_day_id, null))) {
    return err(c, "day_and_place_must_share_trip", 400);
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO reservations (trip_id, day_id, end_day_id, place_id, title, type, status, reservation_time,
      reservation_end_time, location, confirmation_number, notes, travelers, provider, url, cost_cents, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(tripId, b.day_id ?? null, b.end_day_id ?? null, b.place_id ?? null, b.title, b.type ?? "other", b.status ?? "pending",
      b.reservation_time ?? null, b.reservation_end_time ?? null, b.location ?? null, b.confirmation_number ?? null,
      b.notes ?? null, b.travelers ?? null, b.provider ?? null, b.url ?? null, b.cost_cents ?? null, b.currency ?? null)
    .run();
  notifyTrip(c, tripId, { type: "reservation.created", tripId });
  return c.json({ reservation: await c.env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

reservationsNested.patch("/:id/reservations/:resId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const resId = Number(c.req.param("resId"));
  const current = await c.env.DB.prepare("SELECT * FROM reservations WHERE id = ? AND trip_id = ?").bind(resId, tripId).first();
  if (!current) return err(c, "not_found", 404);
  const parsed = reservationPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (!(await sameTrip(c.env.DB, tripId, b.day_id ?? null, b.place_id ?? null)) || !(await sameTrip(c.env.DB, tripId, b.end_day_id ?? null, null))) {
    return err(c, "day_and_place_must_share_trip", 400);
  }
  const cols: Record<string, string> = {
    title: "title", type: "type", status: "status", day_id: "day_id", end_day_id: "end_day_id", place_id: "place_id",
    reservation_time: "reservation_time", reservation_end_time: "reservation_end_time", location: "location",
    confirmation_number: "confirmation_number", notes: "notes", travelers: "travelers", provider: "provider",
    url: "url", cost_cents: "cost_cents", currency: "currency",
  };
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const [key, col] of Object.entries(cols)) {
    const v = (b as Record<string, unknown>)[key];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v as string | number | null);
    }
  }
  if (!sets.length) return err(c, "bad_request", 400);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  await c.env.DB.prepare(`UPDATE reservations SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, resId).run();
  notifyTrip(c, tripId, { type: "reservation.updated", tripId });
  return c.json({ reservation: await c.env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(resId).first() });
});

reservationsNested.delete("/:id/reservations/:resId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const resId = Number(c.req.param("resId"));
  const res = await c.env.DB.prepare("DELETE FROM reservations WHERE id = ? AND trip_id = ?").bind(resId, tripId).run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  notifyTrip(c, tripId, { type: "reservation.deleted", tripId });
  return c.json({ ok: true });
});

/** ---------- hébergements ---------- */
export const accommodationsNested = new Hono<{ Bindings: Env }>();

accommodationsNested.get("/:id/accommodations", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, sd.day_number AS start_day_number, ed.day_number AS end_day_number, p.name AS place_name, p.lat, p.lng
     FROM day_accommodations a JOIN days sd ON sd.id = a.start_day_id JOIN days ed ON ed.id = a.end_day_id
     LEFT JOIN places p ON p.id = a.place_id WHERE a.trip_id = ? ORDER BY sd.day_number`,
  ).bind(tripId).all();
  return c.json({ accommodations: results });
});

accommodationsNested.post("/:id/accommodations", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const parsed = accommodationCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (!(await sameTrip(c.env.DB, tripId, b.start_day_id, null)) || !(await sameTrip(c.env.DB, tripId, b.end_day_id, null))) {
    return err(c, "days_must_share_trip", 400);
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_in_end, check_out, confirmation, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(tripId, b.place_id ?? null, b.start_day_id, b.end_day_id, b.check_in ?? null, b.check_in_end ?? null, b.check_out ?? null, b.confirmation ?? null, b.notes ?? null)
    .run();
  notifyTrip(c, tripId, { type: "accommodation.created", tripId });
  return c.json({ accommodation: await c.env.DB.prepare("SELECT * FROM day_accommodations WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

accommodationsNested.delete("/:id/accommodations/:accId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const accId = Number(c.req.param("accId"));
  const res = await c.env.DB.prepare("DELETE FROM day_accommodations WHERE id = ? AND trip_id = ?").bind(accId, tripId).run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  notifyTrip(c, tripId, { type: "accommodation.deleted", tripId });
  return c.json({ ok: true });
});