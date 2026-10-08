import { z } from "zod";

const lat = z.number().min(-90).max(90).nullable().optional();
const lng = z.number().min(-180).max(180).nullable().optional();
const shortText = (max: number) => z.string().trim().min(1).max(max).optional();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}($|T)/, "expected ISO date")
  .max(32)
  .nullable()
  .optional();

export const registerSchema = z.object({
  // Optionnel comme dans le contrat d'origine : dérivé de l'email si absent.
  username: z.string().trim().min(2).max(32).optional(),
  email: z.string().trim().toLowerCase().max(254).email(),
  password: z.string().min(8).max(256),
  // Accepté pour compatibilité (pas d'invitations dans le MVP : ignoré).
  invite_token: z.string().max(512).optional(),
});

// Contrat d'origine : { email, password, remember_me? }.
// `login` reste accepté comme alias (username ou email) pour curl/scripts.
export const loginSchema = z
  .object({
    email: z.string().trim().max(254).optional(),
    login: z.string().trim().min(1).max(254).optional(),
    password: z.string().min(1).max(256),
    remember_me: z.boolean().optional(),
  })
  .refine((v) => (v.email?.trim() || v.login?.trim()) && v.password, {
    message: "email ou login requis",
  });

export const tripCreateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).nullable().optional(),
  start_date: isoDate,
  end_date: isoDate,
  currency: z.string().trim().length(3).optional(),
  cover_image: z.string().trim().max(2048).nullable().optional(),
  /** Pré-crée N jours numérotés (1..N). Plafonné pour éviter les abus. */
  days_count: z.number().int().min(0).max(60).optional(),
});

export const tripPatchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  start_date: isoDate,
  end_date: isoDate,
  currency: z.string().trim().length(3).nullable().optional(),
  cover_image: z.string().trim().max(2048).nullable().optional(),
  is_archived: z.number().int().min(0).max(1).optional(),
});

export const dayCreateSchema = z.object({
  day_number: z.number().int().min(1).max(1000).optional(),
  date: isoDate,
  title: z.string().trim().max(160).nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
});

export const dayPatchSchema = z.object({
  day_number: z.number().int().min(1).max(1000).optional(),
  date: isoDate,
  title: z.string().trim().max(160).nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
});

export const placeCreateSchema = z.object({
  name: z.string().trim().min(1).max(240),
  day_id: z.number().int().positive().nullable().optional(),
  lat,
  lng,
  address: z.string().trim().max(500).nullable().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
  image_url: z.string().trim().max(2048).nullable().optional(),
  website: z.string().trim().max(2048).nullable().optional(),
});

export const placePatchSchema = placeCreateSchema.partial();

export const instaPinSchema = z.object({
  url: z.string().trim().max(1024),
  lat,
  lng,
  place_id: z.number().int().positive().nullable().optional(),
  caption: shortText(1000),
});

export const wpPinSchema = z.object({
  media_id: z.number().int().positive(),
  lat,
  lng,
  place_id: z.number().int().positive().nullable().optional(),
});

export const photoSharePatchSchema = z.object({
  lat,
  lng,
  place_id: z.number().int().positive().nullable().optional(),
  caption: z.string().trim().max(1000).nullable().optional(),
});

/** Import bulk : une ligne par lieu, `name` obligatoire (lat/lng optionnels). */
export const placesBulkSchema = z.object({
  places: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(240),
        lat: lat,
        lng: lng,
        address: z.string().trim().max(500).nullable().optional(),
        category: z.string().trim().max(80).nullable().optional(),
        notes: z.string().trim().max(8000).nullable().optional(),
        day_id: z.number().int().positive().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const sharePatchSchema = z.object({
  share_map: z.number().int().min(0).max(1).optional(),
  share_photos: z.number().int().min(0).max(1).optional(),
  /** ISO datetime ou null (jamais). Max 1 an. */
  expires_at: z.string().trim().max(32).nullable().optional(),
});

export function fmtIssues(e: z.ZodError): { path: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
