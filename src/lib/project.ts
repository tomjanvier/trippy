/**
 * Constantes d'identité du projet, regroupées ici parce qu'elles servent
 * trois fois : le User-Agent des appels sortants (Nominatim l'exige),
 * l'en-tête `x-trippy-cache`, et l'offre de code source imposée par
 * l'AGPL-3.0 §13 — dès lors qu'un utilisateur interagit avec Trippy par
 * le réseau, l'application doit proposer sans frais le code source
 * correspondant. Le pied de page de l'app affiche ce lien.
 */

export const PROJECT_NAME = "trippy";
export const PROJECT_VERSION = "1.0.0";

/** Dépôt du fork. Doit rester public : c'est la contrepartie du §13. */
export const PROJECT_URL = "https://github.com/tomjanvier/trippy";

/**
 * Origine amont. Trek (https://github.com/liketrek/TREK) est distribué sous
 * AGPL-3.0 ; Trippy en est un fork modifié, donc lui-même AGPL-3.0.
 * Son TRADEMARKS.md impose qu'un fork divergent porte un nom propre : c'est
 * pourquoi le projet s'appelle Trippy et réutilise aucune marque TREK.
 */
export const UPSTREAM_NAME = "TREK";
export const UPSTREAM_URL = "https://github.com/liketrek/TREK";

/** User-Agent des appels vers les services publics sans clé. */
export const USER_AGENT = `${PROJECT_NAME}/${PROJECT_VERSION} (carnet de voyage personnel; +${PROJECT_URL})`;
