import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { assertTripAccess, getDay } from "../db/client";
import { userIdOf } from "../lib/access";
import { err, readJson } from "../lib/http";
import { assignmentCreateSchema, assignmentPatchSchema, assignmentReorderSchema } from "../lib/contracts";
import { fmtIssues } from "../lib/validate";

/**
 * Assignations — l'ordre du jour. Une seule source de vérité : c'est
 * `day_assignments` qui relie les lieux aux jours (cf. migration 0004).
 */
export const assignmentsNested = new Hono<{ Bindings: Env }>();

/** Le plan du voyage : jours + lieux ordonnés, prêt pour le rendu. */
assignmentsNested.get("/:id/plan", async (c) => {
  const tripId = Number(c.req.param("id"));
  const uid = userIdOf(c);
  const share = c.req.query("share");
  let ok = false;
  if (share) {
    const { getShareByToken } = await import("../db/client");
    const row = await getShareByToken(c.env.DB, share);
    ok = !!row && row.trip_id === tripId && !!row.share_map;
  } else {
    ok = !!uid && !!(await assertTripAccess(c.env.DB, tripId, uid));
  }
  if (!ok) return err(c, "unauthorized", 401);
  const db = c.env.DB;
  const plan = await db.batch([
    db.prepare("SELECT * FROM days WHERE trip_id = ? ORDER BY day_number").bind(tripId),
    db.prepare("SELECT id, name, lat, lng, address, category FROM places WHERE trip_id = ?").bind(tripId),
    db.prepare(
      `SELECT a.id, a.day_id, a.place_id, a.order_index, a.notes FROM day_assignments a
       JOIN days d ON d.id = a.day_id WHERE d.trip_id = ? ORDER BY a.day_id, a.order_index, a.id`,
    ).bind(tripId),
  ]);
  const daysRes = plan[0]!;
  const placesRes = plan[1]!;
  const assignRes = plan[2]!;
  const places = placesRes.results as unknown as { id: number; name: string; lat: number | null; lng: number | null; address: string | null; category: string | null }[];
  const assignments = assignRes.results as unknown as { id: number; day_id: number; place_id: number; order_index: number; notes: string | null }[];
  const byDay = new Map<number, typeof assignments>();
  for (const a of assignments) {
    const arr = byDay.get(a.day_id) ?? [];
    arr.push(a);
    byDay.set(a.day_id, arr);
  }
  const days = (daysRes.results as unknown as { id: number; day_number: number; date: string | null; title: string | null }[]).map((d) => ({
    ...d,
    items: (byDay.get(d.id) ?? [])
      .map((a) => {
        const p = places.find((pp) => pp.id === a.place_id);
        return p ? { assignment_id: a.id, place_id: a.place_id, order_index: a.order_index, notes: a.notes, ...p } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  }));
  return c.json({ days, unassigned: places.filter((p) => !assignments.some((a) => a.place_id === p.id)) });
});

assignmentsNested.post("/:id/assignments", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const parsed = assignmentCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const day = await getDay(c.env.DB, b.day_id);
  if (!day || day.trip_id !== tripId) return err(c, "bad_day_id", 400);
  const place = await c.env.DB.prepare("SELECT id FROM places WHERE id = ? AND trip_id = ?").bind(b.place_id, tripId).first();
  if (!place) return err(c, "bad_place_id", 400);
  const next =
    b.order_index ??
    ((await c.env.DB.prepare("SELECT COALESCE(MAX(order_index), -1) AS m FROM day_assignments WHERE day_id = ?").bind(b.day_id).first<{ m: number }>())?.m ?? -1) + 1;
  try {
    const res = await c.env.DB.prepare("INSERT INTO day_assignments (day_id, place_id, order_index, notes) VALUES (?, ?, ?, ?)")
      .bind(b.day_id, b.place_id, next, b.notes ?? null).run();
    return c.json({ assignment: await c.env.DB.prepare("SELECT * FROM day_assignments WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
  } catch {
    return err(c, "already_assigned_to_this_day", 409);
  }
});

/** Réordonnancement d'un jour : le client envoie l'ordre complet (drag & drop). */
assignmentsNested.post("/:id/assignments/reorder", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const dayId = Number(c.req.query("day_id"));
  const day = await getDay(c.env.DB, dayId);
  if (!day || day.trip_id !== tripId) return err(c, "not_found", 404);
  const parsed = assignmentReorderSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const { place_ids: placeIds } = parsed.data;
  const existing = await c.env.DB.prepare("SELECT place_id FROM day_assignments WHERE day_id = ?").bind(dayId).all<{ place_id: number }>();
  const current = new Set((existing.results ?? []).map((r) => r.place_id));
  if (!placeIds.every((p) => current.has(p))) return err(c, "place_not_assigned_to_day", 400);
  await c.env.DB.batch(
    placeIds.map((pid, i) =>
      c.env.DB.prepare("UPDATE day_assignments SET order_index = ? WHERE day_id = ? AND place_id = ?").bind(i, dayId, pid),
    ),
  );
  return c.json({ ok: true, day_id: dayId, count: placeIds.length });
});

/** Déplace une assignation vers un autre jour (glisser un lieu d'un jour à l'autre). */
assignmentsNested.patch("/:id/assignments/:assignmentId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const assignmentId = Number(c.req.param("assignmentId"));
  const row = await c.env.DB.prepare(
    "SELECT a.* FROM day_assignments a JOIN days d ON d.id = a.day_id WHERE a.id = ? AND d.trip_id = ?",
  ).bind(assignmentId, tripId).first<{ id: number; day_id: number }>();
  if (!row) return err(c, "not_found", 404);
  const parsed = assignmentPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (b.day_id !== undefined) {
    const target = await getDay(c.env.DB, b.day_id);
    if (!target || target.trip_id !== tripId) return err(c, "bad_day_id", 400);
  }
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (b.day_id !== undefined) { sets.push("day_id = ?"); binds.push(b.day_id); }
  if (b.order_index !== undefined) { sets.push("order_index = ?"); binds.push(b.order_index); }
  if (b.notes !== undefined) { sets.push("notes = ?"); binds.push(b.notes); }
  if (!sets.length) return err(c, "bad_request", 400);
  await c.env.DB.prepare(`UPDATE day_assignments SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, assignmentId).run();
  return c.json({ assignment: await c.env.DB.prepare("SELECT * FROM day_assignments WHERE id = ?").bind(assignmentId).first() });
});

assignmentsNested.delete("/:id/assignments/:assignmentId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const assignmentId = Number(c.req.param("assignmentId"));
  const res = await c.env.DB.prepare(
    "DELETE FROM day_assignments WHERE id = ? AND day_id IN (SELECT id FROM days WHERE trip_id = ?)",
  ).bind(assignmentId, tripId).run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  return c.json({ ok: true });
});