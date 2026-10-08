import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";
import { requireAuth, signSession, type SessionUser } from "../auth";
import { clientIp, err, readJson, type AppContext } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { fmtIssues, loginSchema, registerSchema } from "../lib/validate";

const enc = new TextEncoder();

async function hashPassword(password: string, saltHex: string): Promise<string> {
  const salt = Uint8Array.from(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: 100_000 }, // max supporté par WebCrypto Workers
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newSalt(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Dérive un username unique depuis l'email (contrat d'origine : username optionnel). */
export async function uniqueUsernameFromEmail(db: D1Database, email: string): Promise<string> {
  const local = email.split("@")[0] ?? "";
  const base = local.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "user";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${[...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const taken = await db.prepare("SELECT 1 AS ok FROM users WHERE lower(username) = ?").bind(candidate).first<{ ok: number }>();
    if (!taken) return candidate.slice(0, 32);
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 32);
}

const auth = new Hono<{ Bindings: Env }>();

/**
 * Le secret de session est obligatoire. S'il manque, AUCUNE session ne peut être
 * signée : l'inscription crée le compte puis échoue, et la connexion échoue.
 *
 * On le vérifie en amont, explicitement, pour deux raisons :
 *  - sans cela, un `catch` trop large autour de l'inscription transforme
 *    l'erreur de configuration en « nom déjà pris », ce qui envoie l'utilisateur
 *    chercher un problème d'identifiant qui n'existe pas — et laisse un compte
 *    orphelin en base à chaque essai ;
 *  - sur une instance auto-hébergée, l'erreur la plus fréquente est justement
 *    « j'ai oublié le secret ». Elle mérite son propre code.
 */
export function missingSecret(c: AppContext): Response | null {
  if (c.env.JWT_SECRET) return null;
  return c.json({ error: "server_misconfigured", reason: "JWT_SECRET absent" }, 500);
}

async function checkRate(c: AppContext, scope: string): Promise<Response | null> {
  const r = await rateLimit(c.env, `auth-${scope}:${clientIp(c)}`, 10, 60);
  if (!r.ok) {
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": String(r.retryAfter) });
  }
  return null;
}

auth.post("/register", async (c) => {
  const limited = await checkRate(c, "register");
  if (limited) return limited;
  const unconfigured = missingSecret(c);
  if (unconfigured) return unconfigured;
  const parsed = registerSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const { email, password } = parsed.data;
  let username = parsed.data.username?.trim();
  if (!username) username = await uniqueUsernameFromEmail(c.env.DB, email);
  const salt = newSalt();
  const password_hash = `${salt}$${await hashPassword(password, salt)}`;

  // Le `try` ne couvre QUE l'insertion. C'était une erreur de le faire englober
  // la signature du jeton : une erreur de configuration devenait alors un conflit
  // d'identifiant, et le compte restait créé en base sans que personne ne puisse
  // s'y connecter.
  let user: SessionUser;
  try {
    const res = await c.env.DB.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)")
      .bind(username, email, password_hash)
      .run();
    user = { id: Number(res.meta.last_row_id), username, email, role: "user" };
  } catch {
    return err(c, "username_or_email_taken", 409);
  }

  const maxAge = 30 * 24 * 3600;
  const token = await signSession(c.env.JWT_SECRET, user, maxAge);
  return c.json({ user, token }, 200, {
    "Set-Cookie": `trippy_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  });
});

auth.post("/login", async (c) => {
  const limited = await checkRate(c, "login");
  if (limited) return limited;
  const unconfigured = missingSecret(c);
  if (unconfigured) return unconfigured;
  // Ménage des clés d'idempotence expirées, une fois par connexion : la table ne
  // grossit pas indéfiniment sans coût sur le chemin des mutations.
  c.executionCtx.waitUntil(
    c.env.DB.prepare("DELETE FROM idempotency_keys WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')").run().catch(() => null),
  );
  const parsed = loginSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const { password } = parsed.data;
  const idRaw = (parsed.data.email ?? parsed.data.login ?? "").trim().toLowerCase();
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?")
    .bind(idRaw, idRaw)
    .first<{ id: number; username: string; email: string; role: string; password_hash: string }>();
  if (!row) return err(c, "invalid_credentials", 401);
  const [salt, expected] = row.password_hash.split("$");
  if (!salt || !expected || !timingSafeEqual(await hashPassword(password, salt), expected)) {
    return err(c, "invalid_credentials", 401);
  }
  const user: SessionUser = { id: row.id, username: row.username, email: row.email, role: row.role };
  // "Remember me" d'origine : session longue, sinon 30 jours.
  const maxAge = parsed.data.remember_me ? 90 * 24 * 3600 : 30 * 24 * 3600;
  const token = await signSession(c.env.JWT_SECRET, user, maxAge);
  return c.json({ user, token }, 200, {
    "Set-Cookie": `trippy_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  });
});

auth.post("/logout", (c) =>
  c.json({ ok: true }, 200, { "Set-Cookie": "trippy_session=; Path=/; HttpOnly; Max-Age=0" }),
);

auth.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

export default auth;
