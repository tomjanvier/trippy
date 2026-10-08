import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { assertTripAccess } from "../db/client";
import { userIdOf } from "../lib/access";
import { err, readJson } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import {
  budgetCreateSchema,
  budgetPatchSchema,
  budgetReconciles,
  categoryCreateSchema,
  packingCreateSchema,
  packingPatchSchema,
  placeTagsSchema,
  tagCreateSchema,
  todoCreateSchema,
  todoPatchSchema,
} from "../lib/contracts";
import { fmtIssues } from "../lib/validate";

async function accessTrip(db: D1Database, tripId: number, userId: number | null): Promise<boolean> {
  return (await assertTripAccess(db, tripId, userId)) !== null;
}

/** ---------- budget ---------- */
export const budgetNested = new Hono<{ Bindings: Env }>();

budgetNested.get("/:id/budget", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const batch = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM budget_items WHERE trip_id = ? ORDER BY sort_order, id").bind(tripId),
    c.env.DB.prepare(
      "SELECT m.budget_item_id, m.user_id, m.share_cents, u.username FROM budget_item_members m JOIN budget_items b ON b.id = m.budget_item_id JOIN users u ON u.id = m.user_id WHERE b.trip_id = ?",
    ).bind(tripId),
    c.env.DB.prepare("SELECT COALESCE(SUM(total_cents), 0) AS total FROM budget_items WHERE trip_id = ?").bind(tripId),
  ]);
  const itemsRes = batch[0]!;
  const membersRes = batch[1]!;
  const totalsRes = batch[2]!;
  const members = membersRes.results as unknown as { budget_item_id: number; user_id: number; username: string; share_cents: number }[];
  const items = (itemsRes.results as unknown as Record<string, unknown>[]).map((it) => ({
    ...it,
    members: members.filter((m) => m.budget_item_id === it.id),
  }));
  return c.json({
    budget_items: items,
    total_cents: (totalsRes.results[0] as unknown as { total: number }).total,
  });
});

budgetNested.post("/:id/budget", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const parsed = budgetCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const total = b.total_cents ?? 0;
  // Parts personnalisés : ils doivent se réconcilier avec le total (fail closed).
  if (b.members && !budgetReconciles(total, b.members)) return err(c, "shares_must_sum_to_total", 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO budget_items (trip_id, category, name, total_cents, currency, persons, days, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(tripId, b.category ?? "Other", b.name, total, b.currency ?? null, b.persons ?? null, b.days ?? null, b.note ?? null, b.sort_order ?? 0)
    .run();
  const itemId = Number(res.meta.last_row_id);
  if (b.members?.length) {
    await c.env.DB.batch(
      b.members.map((m) =>
        c.env.DB.prepare("INSERT INTO budget_item_members (budget_item_id, user_id, share_cents) VALUES (?, ?, ?)").bind(itemId, m.user_id, m.share_cents),
      ),
    );
  }
  notifyTrip(c, tripId, { type: "budget.created", tripId });
  return c.json({ budget_item: await c.env.DB.prepare("SELECT * FROM budget_items WHERE id = ?").bind(itemId).first() }, 200);
});

budgetNested.patch("/:id/budget/:itemId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const itemId = Number(c.req.param("itemId"));
  const current = await c.env.DB.prepare("SELECT * FROM budget_items WHERE id = ? AND trip_id = ?").bind(itemId, tripId).first<{
    id: number;
    total_cents: number;
  }>();
  if (!current) return err(c, "not_found", 404);
  const parsed = budgetPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const newTotal = b.total_cents ?? current.total_cents;
  if (b.members && !budgetReconciles(newTotal, b.members)) return err(c, "shares_must_sum_to_total", 400);
  const cols = ["name", "category", "total_cents", "currency", "persons", "days", "note", "sort_order"] as const;
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
    await c.env.DB.prepare(`UPDATE budget_items SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, itemId).run();
  }
  if (b.members) {
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM budget_item_members WHERE budget_item_id = ?").bind(itemId),
      ...b.members.map((m) =>
        c.env.DB.prepare("INSERT INTO budget_item_members (budget_item_id, user_id, share_cents) VALUES (?, ?, ?)").bind(itemId, m.user_id, m.share_cents),
      ),
    ]);
  }
  notifyTrip(c, tripId, { type: "budget.updated", tripId });
  return c.json({ budget_item: await c.env.DB.prepare("SELECT * FROM budget_items WHERE id = ?").bind(itemId).first() });
});

budgetNested.delete("/:id/budget/:itemId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const itemId = Number(c.req.param("itemId"));
  const res = await c.env.DB.prepare("DELETE FROM budget_items WHERE id = ? AND trip_id = ?").bind(itemId, tripId).run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  notifyTrip(c, tripId, { type: "budget.deleted", tripId });
  return c.json({ ok: true });
});

/** ---------- packing ---------- */
export const packingNested = new Hono<{ Bindings: Env }>();

packingNested.get("/:id/packing", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const { results } = await c.env.DB.prepare("SELECT * FROM packing_items WHERE trip_id = ? ORDER BY sort_order, id").bind(tripId).all();
  const total = (results as unknown as { checked: number }[]).length;
  const checked = (results as unknown as { checked: number }[]).filter((r) => r.checked).length;
  return c.json({ packing_items: results, total, checked });
});

packingNested.post("/:id/packing", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const parsed = packingCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const next = ((await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM packing_items WHERE trip_id = ?").bind(tripId).first<{ m: number }>())?.m ?? -1) + 1;
  const res = await c.env.DB.prepare("INSERT INTO packing_items (trip_id, name, checked, category, sort_order) VALUES (?, ?, ?, ?, ?)")
    .bind(tripId, b.name, b.checked ?? 0, b.category ?? null, next).run();
  notifyTrip(c, tripId, { type: "packing.created", tripId });
  return c.json({ packing_item: await c.env.DB.prepare("SELECT * FROM packing_items WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

packingNested.patch("/:id/packing/:itemId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const itemId = Number(c.req.param("itemId"));
  if (!(await c.env.DB.prepare("SELECT id FROM packing_items WHERE id = ? AND trip_id = ?").bind(itemId, tripId).first())) {
    return err(c, "not_found", 404);
  }
  const parsed = packingPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const col of ["name", "category", "checked", "sort_order"] as const) {
    const v = (b as Record<string, unknown>)[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v as string | number | null);
    }
  }
  if (!sets.length) return err(c, "bad_request", 400);
  await c.env.DB.prepare(`UPDATE packing_items SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, itemId).run();
  notifyTrip(c, tripId, { type: "packing.updated", tripId });
  return c.json({ packing_item: await c.env.DB.prepare("SELECT * FROM packing_items WHERE id = ?").bind(itemId).first() });
});

packingNested.delete("/:id/packing/:itemId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const itemId = Number(c.req.param("itemId"));
  const res = await c.env.DB.prepare("DELETE FROM packing_items WHERE id = ? AND trip_id = ?").bind(itemId, tripId).run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  notifyTrip(c, tripId, { type: "packing.deleted", tripId });
  return c.json({ ok: true });
});

/** ---------- to-do ---------- */
export const todoNested = new Hono<{ Bindings: Env }>();

todoNested.get("/:id/todos", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM todo_items WHERE trip_id = ? ORDER BY checked, priority DESC, COALESCE(due_date, '9999'), sort_order, id",
  ).bind(tripId).all();
  return c.json({ todos: results });
});

todoNested.post("/:id/todos", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const parsed = todoCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const next = ((await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM todo_items WHERE trip_id = ?").bind(tripId).first<{ m: number }>())?.m ?? -1) + 1;
  const res = await c.env.DB.prepare(
    "INSERT INTO todo_items (trip_id, name, checked, category, description, due_date, priority, assigned_user_id, sort_order) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)",
  )
    .bind(tripId, b.name, b.category ?? null, b.description ?? null, b.due_date ?? null, b.priority ?? 0, b.assigned_user_id ?? null, next)
    .run();
  notifyTrip(c, tripId, { type: "todo.created", tripId });
  return c.json({ todo: await c.env.DB.prepare("SELECT * FROM todo_items WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

todoNested.patch("/:id/todos/:todoId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const todoId = Number(c.req.param("todoId"));
  if (!(await c.env.DB.prepare("SELECT id FROM todo_items WHERE id = ? AND trip_id = ?").bind(todoId, tripId).first())) {
    return err(c, "not_found", 404);
  }
  const parsed = todoPatchSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  for (const col of ["name", "category", "description", "due_date", "priority", "assigned_user_id", "checked", "sort_order"] as const) {
    const v = (b as Record<string, unknown>)[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(v as string | number | null);
    }
  }
  if (!sets.length) return err(c, "bad_request", 400);
  await c.env.DB.prepare(`UPDATE todo_items SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, todoId).run();
  notifyTrip(c, tripId, { type: "todo.updated", tripId });
  return c.json({ todo: await c.env.DB.prepare("SELECT * FROM todo_items WHERE id = ?").bind(todoId).first() });
});

todoNested.delete("/:id/todos/:todoId", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const todoId = Number(c.req.param("todoId"));
  const res = await c.env.DB.prepare("DELETE FROM todo_items WHERE id = ? AND trip_id = ?").bind(todoId, tripId).run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  notifyTrip(c, tripId, { type: "todo.deleted", tripId });
  return c.json({ ok: true });
});

/** ---------- tags utilisateur (partagés entre voyages) ---------- */
export const tagsApi = new Hono<{ Bindings: Env }>();

tagsApi.get("/tags", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { results } = await c.env.DB.prepare("SELECT * FROM tags WHERE user_id = ? ORDER BY name").bind(user.id).all();
  return c.json({ tags: results });
});

tagsApi.post("/tags", requireAuth, async (c) => {
  const user = c.get("user")!;
  const parsed = tagCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const res = await c.env.DB.prepare("INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)")
    .bind(user.id, parsed.data.name, parsed.data.color ?? "#10b981").run();
  return c.json({ tag: await c.env.DB.prepare("SELECT * FROM tags WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

tagsApi.delete("/tags/:tagId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const res = await c.env.DB.prepare("DELETE FROM tags WHERE id = ? AND user_id = ?").bind(Number(c.req.param("tagId")), user.id).run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  return c.json({ ok: true });
});

/** ---------- catégories de lieux (globales ou perso) ---------- */
export const categoriesApi = new Hono<{ Bindings: Env }>();

categoriesApi.get("/categories", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM categories WHERE user_id IS NULL OR user_id = ? ORDER BY name",
  ).bind(user.id).all();
  return c.json({ categories: results });
});

categoriesApi.post("/categories", requireAuth, async (c) => {
  const user = c.get("user")!;
  const parsed = categoryCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const res = await c.env.DB.prepare("INSERT INTO categories (name, color, icon, user_id) VALUES (?, ?, ?, ?)")
    .bind(parsed.data.name, parsed.data.color ?? "#6366f1", parsed.data.icon ?? "📍", user.id).run();
  return c.json({ category: await c.env.DB.prepare("SELECT * FROM categories WHERE id = ?").bind(Number(res.meta.last_row_id)).first() }, 200);
});

categoriesApi.delete("/categories/:catId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const res = await c.env.DB.prepare("DELETE FROM categories WHERE id = ? AND user_id = ?").bind(Number(c.req.param("catId")), user.id).run();
  if ((res.meta.changes ?? 0) === 0) return err(c, "not_found", 404);
  return c.json({ ok: true });
});

/** ---------- étiquettes d'un lieu ---------- */
export const placeTagsNested = new Hono<{ Bindings: Env }>();

placeTagsNested.put("/:id/places/:placeId/tags", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const placeId = Number(c.req.param("placeId"));
  const place = await c.env.DB.prepare("SELECT id FROM places WHERE id = ? AND trip_id = ?").bind(placeId, tripId).first();
  if (!place) return err(c, "not_found", 404);
  const parsed = placeTagsSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const { tag_ids: tagIds } = parsed.data;
  // Un lieu ne peut porter que les étiquettes de son propriétaire (pas de fuite inter-comptes).
  const own = await c.env.DB.prepare(`SELECT id FROM tags WHERE id IN (${tagIds.map(() => "?").join(",") || "NULL"})`).bind(...tagIds).all<{ id: number }>();
  const ownIds = new Set((own.results ?? []).map((r) => r.id));
  const invalid = tagIds.filter((t) => !ownIds.has(t));
  if (invalid.length) return err(c, "unknown_tag", 400);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM place_tags WHERE place_id = ?").bind(placeId),
    ...tagIds.map((t) => c.env.DB.prepare("INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)").bind(placeId, t)),
  ]);
  const { results } = await c.env.DB.prepare(
    "SELECT t.* FROM place_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.place_id = ? ORDER BY t.name",
  ).bind(placeId).all();
  notifyTrip(c, tripId, { type: "place.tags", tripId, placeId });
  return c.json({ tags: results });
});

placeTagsNested.get("/:id/places/:placeId/tags", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await accessTrip(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const placeId = Number(c.req.param("placeId"));
  const { results } = await c.env.DB.prepare(
    "SELECT t.* FROM place_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.place_id = ? ORDER BY t.name",
  ).bind(placeId).all();
  return c.json({ tags: results });
});