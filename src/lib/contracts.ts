import { z } from "zod";

// Montants : centimes entiers, jamais négatifs (une remise se modélise par une
// catégorie, pas par un total négatif — cf. Money dans CLAUDE.md).
const cents = z.number().int().min(0).max(1_000_000_000);
const isoDateTime = z.string().trim().max(32).nullable().optional();
const id = z.number().int().positive();

// ---------- assignations (source unique lieu <-> jour) ----------
export const assignmentCreateSchema = z.object({
  day_id: id,
  place_id: id,
  order_index: z.number().int().min(0).max(10_000).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const assignmentReorderSchema = z.object({
  /** Ordre complet du jour : liste de place_id dans l'ordre du matin au soir. */
  place_ids: z.array(id).min(1).max(500),
});

export const assignmentPatchSchema = z.object({
  day_id: id.optional(),
  order_index: z.number().int().min(0).max(10_000).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

// ---------- réservations ----------
export const reservationCreateSchema = z.object({
  title: z.string().trim().min(1).max(240),
  type: z
    .enum(["flight", "train", "bus", "car", "ferry", "restaurant", "museum", "activity", "other"])
    .optional(),
  status: z.enum(["pending", "confirmed", "cancelled"]).optional(),
  day_id: id.nullable().optional(),
  end_day_id: id.nullable().optional(),
  place_id: id.nullable().optional(),
  assignment_id: id.nullable().optional(),
  reservation_time: isoDateTime,
  reservation_end_time: isoDateTime,
  location: z.string().trim().max(300).nullable().optional(),
  confirmation_number: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
  travelers: z.string().trim().max(300).nullable().optional(),
  provider: z.string().trim().max(200).nullable().optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  cost_cents: cents.nullable().optional(),
  currency: z.string().trim().length(3).nullable().optional(),
});

export const reservationPatchSchema = reservationCreateSchema.partial();

// ---------- hébergements ----------
export const accommodationCreateSchema = z
  .object({
    place_id: id.nullable().optional(),
    start_day_id: id,
    end_day_id: id,
    check_in: isoDateTime,
    check_in_end: isoDateTime,
    check_out: isoDateTime,
    confirmation: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .refine((v) => v.start_day_id !== v.end_day_id || v.check_out === undefined, {
    message: "start_day_id et end_day_id doivent différer si check_out est fourni",
  });

// ---------- budget ----------
export const budgetCreateSchema = z.object({
  name: z.string().trim().min(1).max(240),
  category: z.string().trim().min(1).max(80).optional(),
  total_cents: cents.optional(),
  currency: z.string().trim().length(3).nullable().optional(),
  persons: z.number().int().min(1).max(100).nullable().optional(),
  days: z.number().int().min(1).max(365).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  sort_order: z.number().int().min(0).max(100_000).optional(),
  /** Partages personnalisés ; absents = parts égales (persons). */
  members: z
    .array(z.object({ user_id: id, share_cents: cents }))
    .max(50)
    .optional(),
});

export const budgetPatchSchema = budgetCreateSchema.partial();

/** Détecte un budget qui ne se réconcilie pas (somme des parts ≠ total). */
export function budgetReconciles(totalCents: number, shares: { share_cents: number }[]): boolean {
  return shares.reduce((a, s) => a + s.share_cents, 0) === totalCents;
}

// ---------- packing ----------
export const packingCreateSchema = z.object({
  name: z.string().trim().min(1).max(240),
  category: z.string().trim().max(80).nullable().optional(),
  checked: z.number().int().min(0).max(1).optional(),
});

export const packingPatchSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  category: z.string().trim().max(80).nullable().optional(),
  checked: z.number().int().min(0).max(1).optional(),
  sort_order: z.number().int().min(0).max(100_000).optional(),
});

// ---------- to-do ----------
export const todoCreateSchema = z.object({
  name: z.string().trim().min(1).max(240),
  category: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  due_date: z.string().trim().max(32).nullable().optional(),
  priority: z.number().int().min(0).max(3).optional(),
  assigned_user_id: id.nullable().optional(),
});

export const todoPatchSchema = todoCreateSchema.partial().extend({
  checked: z.number().int().min(0).max(1).optional(),
  sort_order: z.number().int().min(0).max(100_000).optional(),
});

// ---------- tags & catégories ----------
export const tagCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().trim().max(32).optional(),
});

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().trim().max(32).optional(),
  icon: z.string().trim().max(8).optional(),
});

export const placeTagsSchema = z.object({ tag_ids: z.array(id).max(50) });

// ---------- recherche & routes ----------
export const searchSchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(25).optional().default(8),
});