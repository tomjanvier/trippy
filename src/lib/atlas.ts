import { z } from "zod";

/**
 * L'atlas : le modèle PAR PAYS de Trippy.
 *
 * Voir `migrations/0006_atlas.sql` pour pourquoi ce domaine est séparé de
 * `trips`. En résumé : un pays est un lieu de mémoire, pas une étape d'un
 * itinéraire ; il survit à ses voyages.
 *
 * Conventions reprises de `journey.ts` : `.trim()` sur tout texte, bornes
 * explicites, booléens en `z.number().int().min(0).max(1)` (D1 stocke du
 * INTEGER), montants en centimes entiers, et sur les PATCH `.optional()` +
 * `.nullable()` pour distinguer « absent » de « effacer ».
 */

const id = z.number().int().positive();
const lat = z.number().min(-90).max(90).nullable().optional();
const lng = z.number().min(-180).max(180).nullable().optional();
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/, "date ISO attendue (AAAA-MM-JJ)").max(10);

/**
 * Code ISO 3166-1 numérique. La norme réserve 001–894, mais les pays non-membres
 * utilisent la plage 900–999 : le Kosovo vaut 983. La borne va donc à 999, sinon
 * un pays comme celui-ci serait refusé par l'API et invisible sur la carte.
 *
 * Le garde-fou utile reste le type entier : c'est lui qui empêche qu'un code
 * alpha-2 ("FR") glisse dans la colonne et fasse silencieusement disparaître un
 * pays, sans message d'erreur.
 */
export const isoN3 = z.number().int().min(1).max(999);

/**
 * Domaines des bonnes adresses. Fermé et volontaire : une liste de dix
 * catégories qui veut dire quelque chose vaut mieux qu'un champ libre où tout
 * se mélange. Les libellés français vivent côté client (`web/src/data/kinds.ts`)
 * pour que la couche API reste dans la langue du code.
 */
export const SPOT_KINDS = [
  "eat",
  "drink",
  "stay",
  "see",
  "walk",
  "shop",
  "other",
] as const;
export type SpotKind = (typeof SPOT_KINDS)[number];

export function isSpotKind(v: unknown): v is SpotKind {
  return typeof v === "string" && (SPOT_KINDS as readonly string[]).includes(v);
}

/**
 * `visited_to` ne peut pas précéder `visited_from`, et `visits` ne peut pas
 * être nul : un pays avec `visits = 0` se colorierait sur la carte comme s'il
 * avait été visité tout en n'ayant jamais été paradé. Erreur explicite plutôt
 * qu'un 400 muet, parce que la cause est toujours un import mal réglé.
 */
const visitWindow = z
  .object({
    visited_from: isoDate.nullable().optional(),
    visited_to: isoDate.nullable().optional(),
    visits: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .refine(
    (v) => !(v.visited_from && v.visited_to) || v.visited_to >= v.visited_from,
    { message: "visited_to ne peut pas précéder visited_from", path: ["visited_to"] },
  );

export const countryCreateSchema = visitWindow.extend({
  iso_n3: isoN3,
  /** Ce que je retiens du pays, en une ligne. */
  note: z.string().trim().max(400).nullable().optional(),
  /** Le récit, sur la page du pays. */
  story: z.string().trim().max(20_000).nullable().optional(),
});

export const countryPatchSchema = z
  .object({
    visited_from: isoDate.nullable().optional(),
    visited_to: isoDate.nullable().optional(),
    visits: z.number().int().min(1).max(1000).nullable().optional(),
    note: z.string().trim().max(400).nullable().optional(),
    story: z.string().trim().max(20_000).nullable().optional(),
  })
  .refine(
    (v) => !(v.visited_from && v.visited_to) || v.visited_to >= v.visited_from,
    { message: "visited_to ne peut pas précéder visited_from", path: ["visited_to"] },
  );

export const countryPhotoCreateSchema = z.object({
  r2_key: z.string().trim().max(512).nullable().optional(),
  external_url: z.string().trim().max(2048).nullable().optional(),
  caption: z.string().trim().max(1000).nullable().optional(),
  taken_on: isoDate.nullable().optional(),
  lat,
  lng,
  sort_order: z.number().int().min(0).max(100_000).optional(),
});

export const countryPhotoPatchSchema = z.object({
  caption: z.string().trim().max(1000).nullable().optional(),
  taken_on: isoDate.nullable().optional(),
  lat,
  lng,
  sort_order: z.number().int().min(0).max(100_000).optional(),
});

export const spotCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(SPOT_KINDS).default("other"),
  city: z.string().trim().max(120).nullable().optional(),
  /** La phrase qui vaut le coup d'être retenue. */
  verdict: z.string().trim().max(1000).nullable().optional(),
  price_cents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  lat,
  lng,
  visited_on: isoDate.nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
  sort_order: z.number().int().min(0).max(100_000).optional(),
});

export const spotPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(SPOT_KINDS).optional(),
  city: z.string().trim().max(120).nullable().optional(),
  verdict: z.string().trim().max(1000).nullable().optional(),
  price_cents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  lat,
  lng,
  visited_on: isoDate.nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
  sort_order: z.number().int().min(0).max(100_000).optional(),
});

/** Une photo doit avoir soit une clé R2, soit une URL externe. */
export function hasPayload(p: { r2_key?: string | null; external_url?: string | null }): boolean {
  return !!p.r2_key || !!p.external_url;
}

/**
 * Ordre du fil de voyage : la dernière visite d'abord, puis la première, puis
 * l'identifiant. C'est ce tri qui décide l'ordre des pays sur la carte, donc
 * l'ordre des traits du fil — un fil qui n'a pas de sens se voit tout de suite.
 */
export interface VisitOrder {
  visited_from: string | null;
  visited_to: string | null;
  iso_n3: number;
}

export function byRecentVisit(a: VisitOrder, b: VisitOrder): number {
  const at = a.visited_to ?? a.visited_from ?? "";
  const bt = b.visited_to ?? b.visited_from ?? "";
  if (at !== bt) return bt < at ? -1 : 1;
  const af = a.visited_from ?? "";
  const bf = b.visited_from ?? "";
  if (af !== bf) return bf < af ? -1 : 1;
  return b.iso_n3 - a.iso_n3;
}

/**
 * Fuseau de visite d'un pays, en années, pour l'étiquette de la carte.
 * Retourne `null` si aucune date n'est connue — la carte omet alors l'étiquette
 * plutôt que d'inventer « ? ».
 */
export function visitYears(c: { visited_from: string | null; visited_to: string | null }): string | null {
  const y = (s: string | null) => (s ? Number(s.slice(0, 4)) : null);
  const from = y(c.visited_from);
  const to = y(c.visited_to);
  if (from === null && to === null) return null;
  if (from !== null && to !== null) return from === to ? String(from) : `${from}–${to}`;
  return String(from ?? to);
}
