#!/usr/bin/env node
/**
 * Remet le mot de passe d'un compte, sans session ni accès à l'API.
 *
 * Utile quand on a oublié le mot de passe d'une instance auto-hébergée, ou pour
 * aligner le compte de démo sur un mot de passe connu. Agit directement sur D1.
 *
 * Le hachage est bit-compatible avec le vérificateur WebCrypto du Worker
 * (`src/routes/auth.ts`) : PBKDF2-SHA256, 100 000 itérations — le plafond de
 * Workers WebCrypto —, sel de 16 octets aléatoires, format `<selHex>$<hashHex>`,
 * comparé à temps constant. Si l'un de ces quatre paramètres change d'un côté,
 * il faut changer l'autre des deux côtés, sinon plus aucun mot de passe ne passe.
 *
 * Usage :
 *   node scripts/reset-password.mjs --email demo@trippy.local [--remote]
 *   PASSWORD='…' node scripts/reset-password.mjs --email moi@exemple.fr --remote
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ITERATIONS = 100_000; // cap WebCrypto Workers — voir src/routes/auth.ts

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

const email = arg("--email");
const remote = has("--remote");
const database = arg("--db") ?? "trek-db";

if (!email) {
  console.error("Usage : node scripts/reset-password.mjs --email <adresse> [--remote] [--db <nom>]");
  process.exit(1);
}

// Généré s'il est absent, sinon refusé : un mot de passe court ou vide posé en
// production par un oubli serait pire que l'échec du script.
const password = process.env.PASSWORD ?? randomBytes(12).toString("base64url");
if (password.length < 8) {
  console.error("Le mot de passe doit faire au moins 8 caractères.");
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
const hash = pbkdf2Sync(password, Buffer.from(salt, "hex"), ITERATIONS, 32, "sha256").toString("hex");
const stored = `${salt}$${hash}`;

const sql = `-- Réinitialisation de mot de passe (PBKDF2-SHA256, ${ITERATIONS} itérations)
UPDATE users SET password_hash = '${stored}', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE lower(email) = '${email.replaceAll("'", "''").toLowerCase()}';
`;

const dir = mkdtempSync(join(tmpdir(), "trippy-reset-"));
const file = join(dir, "reset.sql");
writeFileSync(file, sql);
try {
  const r = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", database, remote ? "--remote" : "--local", `--file=${file}`],
    { stdio: "inherit", cwd: ROOT },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (!process.env.PASSWORD) {
  console.log(`\nMot de passe généré pour ${email} : ${password}`);
}
console.log(`\nConnexion : POST /api/auth/login { "email": "${email}", "password": "…" }`);