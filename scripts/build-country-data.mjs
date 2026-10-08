#!/usr/bin/env node
/**
 * Génère `web/src/data/countries.json` : la correspondance dont l'atlas a besoin
 * pour relier une ligne SQL à un contour, un nom et un drapeau.
 *
 * Pourquoi un fichier généré et non un calcul à l'exécution :
 *  - `iso_n3` (code numérique) est la clé des polygones Natural Earth, mais
 *    l'inverse — du numérique vers un nom et un drapeau — n'est exposé par
 *    aucune API standard du navigateur.
 *  - `Intl.DisplayNames` fournit le nom français, mais sa sortie dépend de la
 *    version d'ICU du runtime. Le générer une fois et le commiter rend l'app
 *    déterministe, y compris hors ligne.
 *
 * `i18n-iso-countries` n'est nécessaire qu'ici : devDependency, jamais importée
 * par l'application. Le fichier produit est commité.
 *
 * Usage : node scripts/build-country-data.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import iso from "i18n-iso-countries";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "web/src/data/countries.json");

/** Drapeau d'un code alpha-2 : deux lettres en indicateurs régionaux (U+1F1E6). */
const flagOf = (a2) => [...a2].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");

// Le paquet n'expose pas d'itérateur de codes numériques : on balaie les 26²
// combinaisons de lettres et on garde celles qu'il reconnaît. Instantané, et sans
// dépendre d'une interne du paquet.
const byNumber = new Map();
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
  for (const d of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const a2 = c + d;
    const n3 = iso.alpha2ToNumeric(a2);
    // `alpha2ToNumeric` renvoie `undefined` sur une entrée inconnue.
    if (n3) byNumber.set(Number(n3), a2);
  }
}
if (byNumber.size < 200) {
  console.error(`Échec : ${byNumber.size} codes reconnus seulement. L'API du paquet a changé.`);
  process.exit(1);
}

const fr = new Intl.DisplayNames(["fr"], { type: "region", fallback: "none" });
const en = new Intl.DisplayNames(["en"], { type: "region", fallback: "code" });

const rows = [];
for (const n3 of [...byNumber.keys()].sort((a, b) => a - b)) {
  const a2 = byNumber.get(n3);
  // `fallback: "none"` renvoie le code lui-même quand le runtime ignore le pays.
  const name = fr.of(a2);
  rows.push({ n3, a2, name: name && name !== a2 ? name : en.of(a2), flag: flagOf(a2) });
}

writeFileSync(OUT, JSON.stringify(rows) + "\n");
console.log(`${rows.length} pays écrits dans web/src/data/countries.json`);
for (const code of ["FR", "JP", "CV", "XK"]) {
  console.log(`  ${code} -> ${JSON.stringify(rows.find((r) => r.a2 === code))}`);
}
