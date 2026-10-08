import type { Context } from "hono";
import type { Env } from "../env";

export type AppContext = Context<{ Bindings: Env }>;

export type ErrStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 502;

export function err(c: AppContext, code: string, status: ErrStatus, extra?: Record<string, unknown>) {
  return c.json({ error: code, ...(extra ?? {}) }, status);
}

export async function readJson<T>(c: AppContext): Promise<T> {
  return (await c.req.json().catch(() => ({}))) as T;
}

export function clientIp(c: AppContext): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function getPagination(c: AppContext, def = 50, max = 100): { limit: number } {
  const n = Number(c.req.query("limit") ?? def);
  const limit = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), max) : def;
  return { limit };
}

/** Curseur keyset opaque base64url : { t: updated_at, id } */
export function encodeCursor(t: string, id: number): string {
  return Buffer.from(JSON.stringify({ t, id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): { t: string; id: number } | null {
  if (!cursor) return null;
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    if (typeof o.t !== "string" || typeof o.id !== "number") return null;
    return { t: o.t, id: o.id };
  } catch {
    return null;
  }
}

export function clampLatLng(lat: unknown, lng: unknown): { lat: number | null; lng: number | null } | { error: string } {
  const la = lat === undefined || lat === null ? null : Number(lat);
  const ln = lng === undefined || lng === null ? null : Number(lng);
  if ((la !== null && (!Number.isFinite(la) || la < -90 || la > 90)) || (ln !== null && (!Number.isFinite(ln) || ln < -180 || ln > 180))) {
    return { error: "bad_latlng" };
  }
  return { lat: la, lng: ln };
}
