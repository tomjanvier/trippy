import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";

/** --- Instagram : mode "embed public" (sans token) --- */

const INSTAGRAM_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i;

export function parseInstagramUrl(url: string): string | null {
  const m = url.match(INSTAGRAM_RE);
  return m?.[1] ?? null;
}

export interface InstagramEmbed {
  shortcode: string;
  url: string;
  html: string;
  thumbnail_url: string | null;
  title: string | null;
  author_name: string | null;
}

/** Résout un lien public via le endpoint oEmbed (pas d'auth, rate-limit doux, 10s timeout). */
export async function fetchInstagramOEmbed(postUrl: string): Promise<InstagramEmbed | null> {
  const shortcode = parseInstagramUrl(postUrl);
  if (!shortcode) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const endpoint = `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(postUrl)}`;
    const res = await fetch(endpoint, {
      signal: ctrl.signal,
      headers: { "user-agent": "trek-cloudflare/0.1 (+map-share)" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      html?: string;
      thumbnail_url?: string;
      title?: string;
      author_name?: string;
    };
    if (typeof body.html !== "string") return null;
    return {
      shortcode,
      url: postUrl,
      html: body.html.slice(0, 20_000),
      thumbnail_url: typeof body.thumbnail_url === "string" ? body.thumbnail_url : null,
      title: typeof body.title === "string" ? body.title : null,
      author_name: typeof body.author_name === "string" ? body.author_name : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Enregistre un post Insta épinglé sur un voyage (avec cache oEmbed). */
export async function saveInstagramShare(
  db: D1Database,
  tripId: number,
  input: { url: string; lat?: number | null; lng?: number | null; place_id?: number | null; caption?: string },
): Promise<number> {
  const embed = await fetchInstagramOEmbed(input.url);
  const res = await db
    .prepare(
      `INSERT INTO photo_shares (trip_id, place_id, source, url, thumbnail_url, caption, lat, lng, author, oembed_json)
       VALUES (?, ?, 'instagram', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tripId,
      input.place_id ?? null,
      input.url,
      embed?.thumbnail_url ?? null,
      input.caption ?? embed?.title ?? null,
      input.lat ?? null,
      input.lng ?? null,
      embed?.author_name ?? null,
      embed ? JSON.stringify(embed) : null,
    )
    .run();
  const id = Number(res.meta.last_row_id);
  if (!Number.isFinite(id)) throw new Error("insert_failed");
  return id;
}
