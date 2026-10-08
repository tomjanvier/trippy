import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { getDay } from "../db/client";
import { tripFromDay } from "../lib/access";
import { err, readJson } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import { dayPatchSchema, fmtIssues } from "../lib/validate";

const days = new Hono<{ Bindings: Env }>();

days.get("/:dayId", requireAuth, async (c) => {
  const uid = c.get("user")!.id;
  const resolved = await tripFromDay(c.env.DB, Number(c.req.param("dayId")), uid);
  if (!resolved) return err(c, "not_found", 404);
  return c.json({ day: await getDay(c.env.DB, resolved.dayId) });
});

days.patch("/:dayId", requireAuth, async (c) => {
  const uid = c.get("user")!.id;
  const dayId = Number(c.req.param("dayId"));
  const resolved = await tripFromDay(c.env.DB, dayId, uid);
  if (!resolved) return err(c, "not_found", 404);
  const parsed = dayPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (b.day_number !== undefined) {
    sets.push("day_number = ?");
    binds.push(b.day_number);
  }
  if (b.date !== undefined) {
    sets.push("date = ?");
    binds.push(b.date);
  }
  if (b.title !== undefined) {
    sets.push("title = ?");
    binds.push(b.title);
  }
  if (b.notes !== undefined) {
    sets.push("notes = ?");
    binds.push(b.notes);
  }
  if (!sets.length) return err(c, "bad_request", 400);
  try {
    await c.env.DB.prepare(`UPDATE days SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, dayId).run();
  } catch {
    return err(c, "day_number_taken", 409);
  }
  notifyTrip(c, resolved.trip.id, { type: "day.updated", tripId: resolved.trip.id });
  return c.json({ day: await getDay(c.env.DB, dayId) });
});

days.delete("/:dayId", requireAuth, async (c) => {
  const uid = c.get("user")!.id;
  const dayId = Number(c.req.param("dayId"));
  const resolved = await tripFromDay(c.env.DB, dayId, uid);
  if (!resolved) return err(c, "not_found", 404);
  // FK : places.day_id passe à NULL automatiquement.
  await c.env.DB.prepare("DELETE FROM days WHERE id = ?").bind(dayId).run();
  notifyTrip(c, resolved.trip.id, { type: "day.deleted", tripId: resolved.trip.id });
  return c.json({ ok: true });
});

export default days;
