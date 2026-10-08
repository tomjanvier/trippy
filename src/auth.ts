import type { Context, Next } from "hono";
import type { Env } from "./env";

export interface SessionUser {
  id: number;
  username: string;
  email: string;
  role: string;
}

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const bin = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signSession(secret: string, user: SessionUser, maxAgeSec = 30 * 24 * 3600): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(
    enc.encode(JSON.stringify({ sub: user.id, username: user.username, email: user.email, role: user.role, iat: now, exp: now + maxAgeSec })),
  );
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(secret: string, token: string): Promise<SessionUser | null> {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as {
      sub: number;
      username: string;
      email: string;
      role: string;
      exp: number;
    };
    if (payload.exp * 1000 < Date.now()) return null;
    return { id: payload.sub, username: payload.username, email: payload.email, role: payload.role };
  } catch {
    return null;
  }
}

export function extractToken(c: Context<{ Bindings: Env }>): string | null {
  const cookie = c.req.header("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)trek_session=([^;]+)/);
  if (m?.[1]) return decodeURIComponent(m[1]);
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

/** Auth optionnelle : remplit user si session valide, sinon null (routes publiques). */
export async function optionalAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<void> {
  // Évite une vérification HMAC sur les routes purement publiques.
  if (c.req.path === "/api/health" || c.req.path.startsWith("/api/shared/")) {
    c.set("user", null);
    return next();
  }
  const token = extractToken(c);
  if (token && c.env.JWT_SECRET) {
    c.set("user", await verifySession(c.env.JWT_SECRET, token));
  } else {
    c.set("user", null);
  }
  await next();
}

/** Auth requise : 401 si pas de session. */
export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const token = extractToken(c);
  const user = token && c.env.JWT_SECRET ? await verifySession(c.env.JWT_SECRET, token) : null;
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
}

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser | null;
  }
}
