#!/usr/bin/env node
/**
 * Télécharge les WOFF2 d'Archivo et d'IBM Plex Mono, et écrit
 * `web/src/fonts.css` pointant sur des chemins locaux.
 *
 * Pourquoi télécharger plutôt que lier le CDN Google Fonts :
 * une PWA doit démarrer hors ligne, et un service worker qui découvre une
 * police tierce au runtime ne peut pas la précacher de façon fiable. Les
 * fichiers sont donc versionnés dans `web/public/fonts/`.
 *
 * Seuls les sous-ensembles `latin` et `latin-ext` sont gardés : le français tient
 * dans `latin` (é, à, ç, ù sont en U+0000-00FF), `latin-ext` couvre les
 * caractères d'Europe centrale que rencontres les noms de lieux.
 *
 * Les deux familles sont sous SIL Open Font License 1.1 — voir NOTICE.md.
 *
 * Usage : node scripts/fetch-fonts.mjs [--force]
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = join(ROOT, "web/public/fonts");
const CSS_OUT = join(ROOT, "web/src/fonts.css");

// Un User-Agent de navigateur moderne est nécessaire : l'API CSS2 sert du
// woff2 seulement aux UA qu'elle reconnaît comme tel, et du ttf aux autres.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Les deux familles demandées. `variable: true` signifie qu'il s'agit d'un seul
 * fichier couvrant toute la plage de graisses : Google Fonts sert alors un fichier
 * unique par sous-ensemble, à declaring `font-weight: 100 900`.
 *
 * Le français tient entièrement dans le sous-ensemble `latin` (é, à, ç, ù, œ sont
 * en U+0000-00FF) ; `latin-ext` n'est donc pas téléchargé, ce qui évite 32 Ko
 * d'Archivo et 9 Ko de Plex Mono pour des caractères que l'application n'affiche
 * jamais.
 */
const WANTED = [
  { family: "Archivo", spec: "Archivo:wght@100..900", file: "archivo", weights: "100 900", variable: true },
  { family: "IBM Plex Mono", spec: "IBM+Plex+Mono:wght@400;500", file: "plex-mono", weights: null, variable: false },
];

const KEEP = new Set(["latin"]);

const force = process.argv.includes("--force");
mkdirSync(FONT_DIR, { recursive: true });

/** Découpe le CSS en blocs `@font-face` annotés par le commentaire qui les precede. */
function parseFaces(css) {
  const faces = [];
  // Le commentaire `/* latin */` précède toujours son bloc dans la sortie de l'API.
  const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/gi;
  let m;
  while ((m = re.exec(css))) {
    const [, subset, block] = m;
    const weight = block.match(/font-weight:\s*(\d+)/)?.[1];
    const url = block.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
    if (subset && weight && url) faces.push({ subset, weight, url });
  }
  return faces;
}

const out = [
  "/* Généré par scripts/fetch-fonts.mjs — ne pas éditer à la main.",
  " * Les WOFF2 sont dans web/public/fonts/ et servis par Workers Static Assets.",
  " * Archivo et IBM Plex Mono sont sous SIL Open Font License 1.1 (NOTICE.md).",
  " */",
  "",
];

for (const { family, spec, file, weights, variable } of WANTED) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  const css = await (await fetch(cssUrl, { headers: { "user-agent": UA } })).text();
  const faces = parseFaces(css).filter((f) => KEEP.has(f.subset));
  if (!faces.length) {
    console.error(`Aucun @font-face retenu pour ${family}. L'API CSS2 a changé de format ?`);
    process.exit(1);
  }
  // Pour une police variable, Google renvoie un fichier par sous-ensemble quel
  // que soit le nombre de graisses demandées : on n'en garde qu'un, déclaré sur
  // toute la plage.
  const unique = variable ? faces.filter((f, i, arr) => arr.findIndex((g) => g.url === f.url) === i) : faces;
  for (const f of unique) {
    const name = variable ? `${file}-${f.subset}.woff2` : `${file}-${f.weight}-${f.subset}.woff2`;
    const path = join(FONT_DIR, name);
    if (force || !existsSync(path)) {
      const buf = Buffer.from(await (await fetch(f.url, { headers: { "user-agent": UA } })).arrayBuffer());
      writeFileSync(path, buf);
      console.log(`  ${name}  ${(buf.length / 1024).toFixed(1)} Ko`);
    } else {
      console.log(`  ${name}  (déjà présent)`);
    }
    out.push(
      "@font-face {",
      `  font-family: "${family}";`,
      "  font-style: normal;",
      `  font-weight: ${weights ?? f.weight};`,
      "  font-display: swap;",
      `  src: url("/fonts/${name}") format("woff2");`,
      "  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2212, U+FEFF, U+FFFD;",
      "}",
      "",
    );
  }
}

writeFileSync(CSS_OUT, out.join("\n"));
console.log(`\nweb/src/fonts.css écrit (${WANTED.length} familles).`);
