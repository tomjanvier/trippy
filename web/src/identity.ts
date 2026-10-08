/**
 * Identité du projet, côté client.
 *
 * Ces valeurs sont le miroir de `src/lib/project.ts` côté Worker. Elles sont en
 * dur et non générées parce qu'elles sont stable : les changer est un acte
 * éditorial, pas une refonte. Le bandeau et le pied de page s'en servent, et
 * surtout l'offre de code source que l'AGPL-3.0 §13 impose.
 *
 * Pourquoi deux fichiers pour les mêmes constantes : le Worker ne peut pas
 * importer depuis `web/` (c'est le même dépôt, mais deux arbres de compilation
 * séparés — le Worker n'a pas de `resolveJsonModule`), et le client ne peut pas
 * importer depuis `src/` (ce serait embarquer du code serveur dans le bundle).
 * Le test `tests/project-identity.test.ts` compare les deux fichiers pour que la
 * duplication ne diverge pas en silence.
 */

export const PROJECT_NAME = "trippy";

export const PROJECT_URL = "https://github.com/tomjanvier/trippy";

export const UPSTREAM_NAME = "TREK";

export const UPSTREAM_URL = "https://github.com/liketrek/TREK";

export const VERSION = "1.0.0";
