/**
 * Libellés des catégories de bonnes adresses.
 *
 * Le domaine fermé vit côté API (`SPOT_KINDS` dans `src/lib/atlas.ts`) ; la
 * traduction, elle, vit ici. Une API qui renvoyait du français
 * obligerait le client à le deviner, et un client qui invente ses propres libellés
 * ne peut plus les traduire.
 */
export interface SpotKind {
  id: string;
  /** Étiquette courte : tient sur une ligne dans la liste. */
  label: string;
  /** Ce que la catégorie décrit, pour l'utilisateur qui hésite. */
  hint: string;
}

export const SPOT_KIND_LABELS: Record<string, SpotKind> = {
  eat: { id: "eat", label: "Manger", hint: "Restaurants, casse-croûte, ce qu'on mange vraiment" },
  drink: { id: "drink", label: "Boire", hint: "Cafés, bars, caves" },
  stay: { id: "stay", label: "Dormir", hint: "Hôtels, maisons, chambres d'hôtes" },
  see: { id: "see", label: "Voir", hint: "Musées, monuments, sites à ne pas rater" },
  walk: { id: "walk", label: "Marcher", hint: "Balades, quartiers, paysages" },
  shop: { id: "shop", label: "Acheter", hint: "Boutiques, marchés, ateliers" },
  other: { id: "other", label: "Autre", hint: "Ni une catégorie ni une autre" },
};

export const SPOT_KIND_ORDER = ["eat", "drink", "stay", "see", "walk", "shop", "other"] as const;

/** Libellé d'une catégorie, avec repli sur « Autre » pour une valeur inconnue. */
export function spotKindLabel(kind: string): string {
  return SPOT_KIND_LABELS[kind]?.label ?? SPOT_KIND_LABELS.other!.label;
}
