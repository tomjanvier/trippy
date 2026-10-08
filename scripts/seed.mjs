#!/usr/bin/env node
/**
 * Seed de démo : crée un utilisateur + voyage + jours + lieux + lien de partage.
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
const password = process.env.SEED_PASSWORD ?? "trek-demo-123";
if (password.length < 8) {
  console.error("SEED_PASSWORD doit faire >= 8 caractères");
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
const hash = pbkdf2Sync(password, Buffer.from(salt, "hex"), 100_000, 32, "sha256").toString("hex"); // aligné sur le Worker (cap WebCrypto 100k)
const esc = (s) => `'${s.replaceAll("'", "''")}'`;

const sql = `-- Seed trek-cloudflare (généré, rejouable : INSERT OR IGNORE)
INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (1, 'demo', 'demo@trek.local', ${esc(`${salt}$${hash}`)});
INSERT OR IGNORE INTO trips (id, user_id, title, description, start_date, end_date, currency) VALUES (1, 1, 'Islande 2026', 'Tour de démonstration', '2026-07-01', '2026-07-08', 'EUR');
INSERT OR IGNORE INTO days (id, trip_id, day_number, date, title) VALUES (1, 1, 1, '2026-07-01', 'Arrivée'), (2, 1, 2, '2026-07-02', 'Cercle d''or'), (3, 1, 3, '2026-07-03', 'Côte sud');
INSERT OR IGNORE INTO places (id, trip_id, day_id, name, lat, lng, address) VALUES
  (1, 1, 2, 'Geysir', 64.3105, -20.3029, 'Geysir, Islande'),
  (2, 1, 3, 'Seljalandsfoss', 63.6156, -19.9886, 'Seljalandsfoss, Islande');
INSERT OR IGNORE INTO photo_shares (trip_id, place_id, source, url, thumbnail_url, caption, lat, lng, author) VALUES
  (1, 1, 'instagram', 'https://www.instagram.com/p/DEMO123/', NULL, 'Geysir au soleil de minuit (exemple)', 64.3105, -20.3029, 'demo');
INSERT OR IGNORE INTO share_tokens (trip_id, token) VALUES (1, 'demo-share-token-replace-me');
`;

const dir = mkdtempSync(join(tmpdir(), "trek-seed-"));
const file = join(dir, "seed.sql");
writeFileSync(file, sql);
console.log(`Seed SQL écrit : ${file}`);
console.log("Compte démo : demo / demo@trek.local");

const r = spawnSync("npx", ["wrangler", "d1", "execute", "trek-db", remote ? "--remote" : "--local", `--file=${file}`], {
  stdio: "inherit",
  cwd: ROOT,
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("\nPense à régénérer le token de partage : POST /api/trips/1/share");
