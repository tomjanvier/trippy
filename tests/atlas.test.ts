import { describe, expect, it } from "vitest";
import {
  byRecentVisit,
  countryCreateSchema,
  countryPatchSchema,
  countryPhotoCreateSchema,
  hasPayload,
  isSpotKind,
  SPOT_KINDS,
  spotCreateSchema,
  spotPatchSchema,
  visitYears,
} from "../src/lib/atlas";

describe("contrats atlas", () => {
  it("pays : iso_n3 est un entier ISO dans les bornes de la norme (900-999 inclus)", () => {
    expect(countryCreateSchema.safeParse({ iso_n3: 250 }).success).toBe(true); // France
    expect(countryCreateSchema.safeParse({ iso_n3: 392 }).success).toBe(true); // Japon
    // Un code alpha-2 glisserait dans la colonne et ferait silencieusement
    // disparaître le pays de la carte : le garde-fou est le type entier.
    expect(countryCreateSchema.safeParse({ iso_n3: "FR" }).success).toBe(false);
    expect(countryCreateSchema.safeParse({ iso_n3: 250.5 }).success).toBe(false);
    expect(countryCreateSchema.safeParse({ iso_n3: 0 }).success).toBe(false);
    expect(countryCreateSchema.safeParse({ iso_n3: 895 }).success).toBe(true); // plage 900-999 : le Kosovo vaut 983
    expect(countryCreateSchema.safeParse({ iso_n3: 1000 }).success).toBe(false); // hors des bornes ISO
    expect(countryCreateSchema.safeParse({}).success).toBe(false);
  });

  it("pays : la fenêtre de visite est cohérente et les visites valent au moins 1", () => {
    expect(countryCreateSchema.safeParse({ iso_n3: 250, visited_from: "2024-05-01", visited_to: "2024-05-12" }).success).toBe(true);
    expect(countryCreateSchema.safeParse({ iso_n3: 250, visited_from: "2024-05-12", visited_to: "2024-05-01" }).success).toBe(false);
    // Un pays avec visits = 0 se colorierait comme visité tout en n'ayant jamais
    // été paradé.
    expect(countryCreateSchema.safeParse({ iso_n3: 250, visits: 0 }).success).toBe(false);
    expect(countryCreateSchema.safeParse({ iso_n3: 250, visits: 1 }).success).toBe(true);
    expect(countryCreateSchema.safeParse({ iso_n3: 250, visited_from: "mai 2024" }).success).toBe(false);
  });

  it("pays PATCH : absent ne touche pas, null efface", () => {
    expect(countryPatchSchema.safeParse({}).success).toBe(true);
    expect(countryPatchSchema.safeParse({ note: "beaucoup de vent" }).success).toBe(true);
    expect(countryPatchSchema.safeParse({ note: null }).success).toBe(true);
    expect(countryPatchSchema.safeParse({ visits: 0 }).success).toBe(false);
    expect(countryPatchSchema.safeParse({ story: "x".repeat(20_001) }).success).toBe(false);
  });

  it("photo de pays : lien externe accepté, coordonnées optionnelles et bornées", () => {
    expect(countryPhotoCreateSchema.safeParse({ external_url: "https://exemple.fr/a.jpg" }).success).toBe(true);
    expect(countryPhotoCreateSchema.safeParse({ external_url: "https://exemple.fr/a.jpg", lat: 48.85, lng: 2.35 }).success).toBe(true);
    expect(countryPhotoCreateSchema.safeParse({ external_url: "https://exemple.fr/a.jpg", lat: 91 }).success).toBe(false);
    expect(hasPayload({ external_url: "https://exemple.fr/a.jpg" })).toBe(true);
    expect(hasPayload({})).toBe(false);
  });

  it("bonnes adresses : catégorie en liste fermée, verdict et centimes", () => {
    expect(spotCreateSchema.safeParse({ name: "Café slipped" }).success).toBe(true);
    expect(spotCreateSchema.safeParse({ name: "Chez Léa", kind: "eat" }).success).toBe(true);
    expect(spotCreateSchema.safeParse({ name: "Chez Léa", kind: "restaurant" }).success).toBe(false);
    expect(spotCreateSchema.safeParse({ name: "", kind: "eat" }).success).toBe(false);
    expect(spotCreateSchema.safeParse({ name: "x", price_cents: -1 }).success).toBe(false);
    expect(spotCreateSchema.safeParse({ name: "x", price_cents: 18 }).success).toBe(true);
    // Sans catégorie explicite, une adresse est une adresse.
    expect(spotCreateSchema.parse({ name: "x" }).kind).toBe("other");
    expect(SPOT_KINDS.every(isSpotKind)).toBe(true);
    expect(isSpotKind("nope")).toBe(false);
  });

  it("bonnes adresses PATCH : chaque champ est effaçable", () => {
    expect(spotPatchSchema.safeParse({}).success).toBe(true);
    expect(spotPatchSchema.safeParse({ verdict: null }).success).toBe(true);
    expect(spotPatchSchema.safeParse({ kind: "drink" }).success).toBe(true);
    expect(spotPatchSchema.safeParse({ kind: "dive" }).success).toBe(false);
  });

  it("fil de voyage : le plus récent d'abord, et stable à égalité", () => {
    const ordre = [
      { iso_n3: 250, visited_from: "2019-04-01", visited_to: "2019-04-10" },
      { iso_n3: 392, visited_from: "2025-03-01", visited_to: "2025-04-01" },
      { iso_n3: 724, visited_from: "2022-06-01", visited_to: "2022-06-20" },
    ].sort(byRecentVisit);
    expect(ordre.map((x) => x.iso_n3)).toEqual([392, 724, 250]);
  });

  it("fil de voyage : un pays sans date passe après un pays daté, jamais avant", () => {
    const ordre = [
      { iso_n3: 250, visited_from: null, visited_to: null },
      { iso_n3: 392, visited_from: "2025-03-01", visited_to: null },
    ].sort(byRecentVisit);
    expect(ordre.map((x) => x.iso_n3)).toEqual([392, 250]);
  });

  it("étiquette d'années : une année, un intervalle, ou rien du tout", () => {
    expect(visitYears({ visited_from: "2025-03-01", visited_to: "2025-04-01" })).toBe("2025");
    expect(visitYears({ visited_from: "2019-04-01", visited_to: "2025-04-01" })).toBe("2019–2025");
    expect(visitYears({ visited_from: "2025-03-01", visited_to: null })).toBe("2025");
    expect(visitYears({ visited_from: null, visited_to: "2025-04-01" })).toBe("2025");
    // Aucune date connue : la carte omet l'étiquette plutôt que d'inventer.
    expect(visitYears({ visited_from: null, visited_to: null })).toBeNull();
  });
});
