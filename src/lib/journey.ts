import { z } from "zod";

const id = z.number().int().positive();
const lat = z.number().min(-90).max(90).nullable().optional();
const lng = z.number().min(-180).max(180).nullable().optional();
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/).max(10);

export const journeyCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(8000).nullable().optional(),
  started_at: isoDate.nullable().optional(),
  ended_at: isoDate.nullable().optional(),
  /** Voyage(s) associé(s) au journal. */
  trip_ids: z.array(id).max(20).optional(),
});

/**
 * PATCH : chaque champ est `.optional()` ET `.nullable()` — absent = ne pas toucher,
 * null = effacer. Sans `.optional()`, zod rendrait le champ obligatoire et le client
 * devrait renvoyer tout l'objet à chaque mise à jour.
 */
export const journeyPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(8000).nullable().optional(),
  status: z.enum(["draft", "ongoing", "done"]).optional(),
  started_at: isoDate.nullable().optional(),
  ended_at: isoDate.nullable().optional(),
  is_public: z.number().int().min(0).max(1).optional(),
});

export const checkinCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  place_id: id.nullable().optional(),
  lat,
  lng,
  address: z.string().trim().max(500).nullable().optional(),
  country_code: z.string().trim().length(2).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  checked_in_at: z.string().trim().max(32),
  source: z.enum(["manual", "trip", "photo"]).optional(),
});

export const entryCreateSchema = z.object({
  entry_date: isoDate,
  title: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().max(20_000).nullable().optional(),
  mood: z.string().trim().max(32).nullable().optional(),
  weather: z.string().trim().max(120).nullable().optional(),
  checkin_id: id.nullable().optional(),
});

export const entryPatchSchema = z.object({
  entry_date: isoDate.optional(),
  title: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().max(20_000).nullable().optional(),
  mood: z.string().trim().max(32).nullable().optional(),
  weather: z.string().trim().max(120).nullable().optional(),
  checkin_id: id.nullable().optional(),
  sort_order: z.number().int().min(0).max(100_000).optional(),
});

export const journeyPhotoCreateSchema = z.object({
  source: z.enum(["upload", "instagram", "wordpress"]),
  r2_key: z.string().trim().max(512).nullable().optional(),
  external_url: z.string().trim().max(2048).nullable().optional(),
  thumbnail_url: z.string().trim().max(2048).nullable().optional(),
  caption: z.string().trim().max(1000).nullable().optional(),
  lat,
  lng,
  taken_at: z.string().trim().max(32).nullable().optional(),
  author: z.string().trim().max(200).nullable().optional(),
  entry_id: id.nullable().optional(),
});

export const journeyPhotoPatchSchema = z.object({
  caption: z.string().trim().max(1000).nullable().optional(),
  lat,
  lng,
  entry_id: id.nullable().optional(),
  sort_order: z.number().int().min(0).max(100_000).optional(),
});

/** Une photo doit avoir soit une clé R2, soit une URL externe. */
export function hasPayload(p: { r2_key?: string | null; external_url?: string | null }): boolean {
  return !!p.r2_key || !!p.external_url;
}