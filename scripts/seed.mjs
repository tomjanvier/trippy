#!/usr/bin/env node
/**
 * Seed de DÉMO. Crée un utilisateur, un voyage, son plan, un lien de partage, et
 * quelques pays sur l'atlas — sans quoi la page d'accueil est un rectangle vide
 * et on ne peut pas juger la carte.
 *
 * Ces pays sont inventés et servent uniquement à faire tourner l'interface. Pour
 * un usage réel, les effacer :
 *   npx wrangler d1 execute trek-db --local --command "DELETE FROM spots;
 *     DELETE FROM country_photos; DELETE FROM countries;"
 *
 * Usage :
 *   SEED_PASSWORD='mot-de-passe-solide' node scripts/seed.mjs [--remote]
 * Le hash PBKDF2 (node:crypto) est bit-compatible avec la vérif WebCrypto du Worker.
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const remote = process.argv.includes("--remote");
const password = process.env.SEED_PASSWORD ?? "trippy-demo-123";
if (password.length < 8) {
  console.error("SEED_PASSWORD doit faire >= 8 caractères");
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
const hash = pbkdf2Sync(password, Buffer.from(salt, "hex"), 100_000, 32, "sha256").toString("hex"); // aligné sur le Worker (cap WebCrypto 100k)
const esc = (s) => `'${s.replaceAll("'", "''")}'`;

const sql = `-- Seed trippy (généré, rejouable : INSERT OR IGNORE)
INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (1, 'demo', 'demo@trippy.local', ${esc(`${salt}$${hash}`)});
INSERT OR IGNORE INTO trips (id, user_id, title, description, start_date, end_date, currency) VALUES (1, 1, 'Islande 2026', 'Tour de démonstration', '2026-07-01', '2026-07-08', 'EUR');
INSERT OR IGNORE INTO days (id, trip_id, day_number, date, title) VALUES (1, 1, 1, '2026-07-01', 'Arrivée'), (2, 1, 2, '2026-07-02', 'Cercle d''or'), (3, 1, 3, '2026-07-03', 'Côte sud');
INSERT OR IGNORE INTO places (id, trip_id, name, lat, lng, address) VALUES
  (1, 1, 'Geysir', 64.3105, -20.3029, 'Geysir, Islande'),
  (2, 1, 'Seljalandsfoss', 63.6156, -19.9886, 'Seljalandsfoss, Islande');
-- Le rattachement jour ↔ lieu vit dans day_assignments depuis la migration 0004
-- (places.day_id n'existe plus). order_index suit l'ordre du plan.
INSERT OR IGNORE INTO day_assignments (day_id, place_id, order_index) VALUES (2, 1, 0), (3, 2, 0);
INSERT OR IGNORE INTO photo_shares (trip_id, place_id, source, url, thumbnail_url, caption, lat, lng, author) VALUES
  (1, 1, 'instagram', 'https://www.instagram.com/p/DEMO123/', NULL, 'Geysir au soleil de minuit (exemple)', 64.3105, -20.3029, 'demo');
INSERT OR IGNORE INTO share_tokens (trip_id, token) VALUES (1, 'demo-share-token-replace-me');

-- --------------------------------------------------------------- atlas (démo)
-- l'iso_n3' = code ISO 3166-1 numérique, la clé des contours Natural Earth.
-- Codes ISO 3166-1 numériques, vérifiés contre web/src/data/countries.json :
-- 620 Portugal, 724 Espagne, 250 France, 392 Japon, 356 Inde, 764 Thaïlande,
-- 152 Chili, 380 Italie, 484 Mexique.
INSERT OR IGNORE INTO countries (id, user_id, iso_n3, visited_from, visited_to, visits, note, story) VALUES
  (1, 1, 620, '2022-05-02', '2022-05-16', 2, 'L''ouest du pays, où la lumière tombe de travers', 'Trois semaines à marcher sur la côte, du nord au sud.'),
  (2, 1, 724, '2022-05-16', '2022-05-28', 1, 'Un train pour rien, et la meilleure table du monde', NULL),
  (3, 1, 250, '2019-08-10', '2019-08-24', 3, 'La maison où l''on mangeait', 'Trois étés de suite chez mes parents.'),
  (4, 1, 392, '2024-03-28', '2024-04-12', 1, 'Vingt jours à pied dans le nord', NULL),
  (5, 1, 356, '2023-11-04', '2023-11-22', 1, 'La nourriture à elle seule justifie le voyage', NULL),
  (6, 1, 764, '2025-01-09', '2025-01-24', 1, 'Claustrophobe, magnifique', NULL),
  (7, 1, 152, '2018-05-06', '2018-05-19', 1, 'Sept heures de route, et du vent partout', NULL),
  (8, 1, 380, '2021-09-14', '2021-09-24', 1, 'On y mange bien et pas cher', NULL),
  (9, 1, 484, '2017-12-01', '2017-12-18', 1, 'La route des tavernes', NULL);

INSERT OR IGNORE INTO spots (id, country_id, name, kind, city, verdict, price_cents, lat, lng, visited_on, sort_order) VALUES
  (1, 1, 'Casa do Julio', 'eat', 'Lisbonne', 'Le bacalhau vaut le détour depuis dix ans, et la file deborde sur la rue d''a cote.', 2400, 38.7101, -9.1319, '2022-05-09', 0),
  (2, 1, 'Cafe Sao Bento de Avila', 'drink', 'Lisbonne', 'Le petit-dejeuner le moins cher et le meilleur du quartier. Arriver avant dix heures.', 300, 38.7168, -9.1419, '2022-05-11', 0),
  (3, 1, 'Quinta da Regaleira', 'see', 'Sintra', 'Y aller avant neuf heures, sans quoi on ne voit plus rien du tout.', 1500, 38.7965, -9.3966, '2022-05-14', 0),
  (4, 2, 'Mercado de San Miguel', 'eat', 'Madrid', 'Touristique, et je m''en fous : les comptoirs et les produits valent le passage.', 1800, 40.4067, -3.7086, '2022-05-20', 0),
  (5, 2, 'La Ardosa', 'eat', 'Madrid', 'Le cocido le plus honnete de la ville, et les murs couverts de cadres sans aucun rapport avec la cuisine.', 2000, 40.4074, -3.7034, '2022-05-21', 0),
  (6, 3, 'Chez Meme', 'eat', 'Saint-Malo', 'Le diner de ma grand-mere. Rien de chic, tout de bon.', NULL, 48.6489, -2.0203, '2019-08-14', 0),
  (7, 4, 'Tsukiji outer market', 'eat', 'Tokyo', 'Y aller a six heures. A neuf heures il reste des coins de poisson et des touristes.', 3000, 35.6654, 139.7707, '2024-04-02', 0),
  (8, 5, 'Karim''s', 'eat', 'New Delhi', 'Le goat biryani le moins cher du monde, et la salle pleine a craquer.', 400, 28.6562, 77.2410, '2023-11-12', 0),
  (9, 6, 'Chatuchak', 'shop', 'Bangkok', 'Y aller le samedi matin seulement. Le reste de la semaine, ce sont des etals vides.', NULL, 13.7999, 100.5502, '2025-01-18', 0),
  (10, 7, 'Le Djamaa el Djazair', 'drink', 'Alger', 'Le soir tout se passe sur les terrasses, et personne ne commande une biere avant dix-sept heures.', 500, 36.7753, 3.0592, '2018-05-10', 0),
  (11, 8, 'Trattoria da Beppe', 'eat', 'Bologne', 'La tagliatelle al ragu, et les portions qu''on finit pas. Prevoir l''apres-midi pour ne rien faire.', 1800, 44.4928, 11.3431, '2021-09-17', 0),
  (12, 9, 'Los Cocuyos', 'eat', 'Mexico', 'Une taqueria de rue, et le pastor vaut le detour depuis que j''ai gouté autre chose.', 700, 19.4194, -99.1456, '2017-12-08', 0);
`;

const dir = mkdtempSync(join(tmpdir(), "trippy-seed-"));
const file = join(dir, "seed.sql");
writeFileSync(file, sql);
console.log(`Seed SQL écrit : ${file}`);
console.log("Compte démo : demo / demo@trippy.local");

const r = spawnSync("npx", ["wrangler", "d1", "execute", "trek-db", remote ? "--remote" : "--local", `--file=${file}`], {
  stdio: "inherit",
  cwd: ROOT,
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("\nPense à régénérer le token de partage : POST /api/trips/1/share");
