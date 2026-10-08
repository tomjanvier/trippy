/**
 * L'atlas : les codes pays.
 *
 * `countries.json` est GÉNÉRÉ par `scripts/build-country-data.mjs` et commité.
 * On ne le regénère pas à l'exécution : `Intl.DisplayNames` ne sait pas
 * traduire un code numérique, et sa sortie dépend de la version d'ICU du
 * runtime — donc un nom de pays pourrait changer d'une machine à l'autre.
 */
import rows from "./countries.json";

export interface CountryMeta {
  /** Code ISO 3166-1 numérique — la clé des polygones Natural Earth. */
  n3: number;
  /** Code ISO 3166-1 alpha-2, celui qu'on stocke côté API. */
  a2: string;
  /** Nom français (ou anglais pour les rares pays hors ICU français). */
  name: string;
  flag: string;
}

const byN3 = new Map<number, CountryMeta>();
const byA2 = new Map<string, CountryMeta>();
for (const r of rows as CountryMeta[]) {
  byN3.set(r.n3, r);
  byA2.set(r.a2, r);
}

export const COUNTRIES = rows as CountryMeta[];

/** Métadonnées d'un pays depuis son code numérique, ou null si inconnu. */
export function countryOfN3(n3: number): CountryMeta | null {
  return byN3.get(n3) ?? null;
}

/** Métadonnées d'un pays depuis son code alpha-2 (source : les check-ins). */
export function countryOfA2(a2: string): CountryMeta | null {
  return byA2.get(a2.toUpperCase()) ?? null;
}

/**
 * Drapeau d'un code alpha-2, calculé : deux lettres en indicateurs régionaux.
 * Utilisé quand on n'a qu'un alpha-2 sous la main (une suggestion, un check-in).
 */
export function flagOfA2(a2: string): string {
  return [...a2.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}
