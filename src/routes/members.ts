import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { assertTripAccess } from "../db/client";
import { userIdOf } from "../lib/access";
import { err, readJson } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import { fmtIssues } from "../lib/validate";

const inviteSchema = z
  .object({
    user_id: z.number().int().positive().optional(),
    email: z.string().trim().toLowerCase().max(254).email().optional(),
    username: z.string().trim().min(2).max(32).optional(),
  })
  .refine((v) => v.user_id !== undefined || v.email !== undefined || v.username !== undefined, {
    message: "user_id, email ou username requis",
  });

/** Membres imbriqués sous /api/trips/:id/members. */
export const membersNested = new Hono<{ Bindings: Env }>();

membersNested.get("/:id/members", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, tripId, userIdOf(c));
  if (!trip) return err(c, "not_found", 404);
  const owner = await c.env.DB.prepare("SELECT id, username, email FROM users WHERE id = ?").bind(trip.user_id).first();
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.email, m.added_at FROM trip_members m JOIN users u ON u.id = m.user_id WHERE m.trip_id = ? ORDER BY m.added_at`,
  ).bind(tripId).all();
  return c.json({ owner, members: results });
});

membersNested.post("/:id/members", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const tripId = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, tripId, uid);
  if (!trip || trip.user_id !== uid) return err(c, "not_found", 404);
  const parsed = inviteSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const target =
    b.user_id !== undefined
      ? await c.env.DB.prepare("SELECT id, username FROM users WHERE id = ?").bind(b.user_id).first<{ id: number; username: string }>()
      : b.email !== undefined
        ? await c.env.DB.prepare("SELECT id, username FROM users WHERE lower(email) = ?").bind(b.email).first<{ id: number; username: string }>()
        : await c.env.DB.prepare("SELECT id, username FROM users WHERE lower(username) = ?").bind(b.username!.toLowerCase()).first<{ id: number; username: string }>();
  if (!target) return err(c, "user_not_found", 404);
  if (target.id === trip.user_id) return err(c, "cannot_add_owner", 400);
  const res = await c.env.DB.prepare("INSERT INTO trip_members (trip_id, user_id) VALUES (?, ?) ON CONFLICT(trip_id, user_id) DO NOTHING")
    .bind(tripId, target.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "already_member", 409);
  notifyTrip(c, tripId, { type: "member.added", tripId, userId: target.id });
  return c.json({ member: { id: target.id, username: target.username } }, 200);
});

membersNested.delete("/:id/members/:userId", requireAuth, async (c) => {
  const uid = userIdOf(c)!;
  const tripId = Number(c.req.param("id"));
  const targetId = Number(c.req.param("userId"));
  const trip = await assertTripAccess(c.env.DB, tripId, uid);
  if (!trip) return err(c, "not_found", 404);
  if (targetId === trip.user_id) return err(c, "cannot_remove_owner", 400);
  // Le propriétaire gère tout ; un membre ne peut que se retirer lui-même.
  if (trip.user_id !== uid && targetId !== uid) return err(c, "forbidden", 403);
  const res = await c.env.DB.prepare("DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?").bind(tripId, targetId).run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  notifyTrip(c, tripId, { type: "member.removed", tripId, userId: targetId });
  return c.json({ ok: true });
});
