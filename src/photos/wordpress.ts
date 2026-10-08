import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env";

export interface WpMedia {
  id: number;
  source_url: string;
  caption?: { rendered?: string };
  alt_text?: string;
  date?: string;
  author?: number;
  mime_type?: string;
  media_details?: { width?: number; height?: number };
  // Champs géo possibles selon plugins (Geolocation, Media Library Assistant...) — best effort.
  meta?: Record<string, unknown>;
  latitude?: number;
  longitude?: number;
}

export interface WpPost {
  id: number;
  link: string;
  title?: { rendered?: string };
  date?: string;
  _embedded?: { "wp:featuredmedia"?: WpMedia[] };
}

function siteOf(env: Env): string | null {
  const raw = (env.WP_SITE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function wpHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = { "user-agent": "trek-cloudflare/0.1 (+wordpress-sync)" };
  if (env.WP_USERNAME && env.WP_APP_PASSWORD) {
    h.authorization = `Basic ${btoa(`${env.WP_USERNAME}:${env.WP_APP_PASSWORD}`)}`;
  }
  return h;
}

async function wpGet<T>(env: Env, path: string, params: Record<string, string> = {}): Promise<T> {
  const site = siteOf(env);
  if (!site) throw new Error("wordpress_not_configured");
  const url = new URL(`${site}/wp-json/wp/v2${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal, headers: wpHeaders(env) });
    if (!res.ok) throw new Error(`wordpress_upstream_${res.status}`);
    // Garde-fou taille réponse (1.5 Mo max)
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 1_500_000) throw new Error("wordpress_response_too_large");
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } finally {
    clearTimeout(t);
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Liste les médias récents du site WP (filtre optionnel par recherche). */
export async function listWordPressMedia(
  env: Env,
  opts: { search?: string; page?: number; perPage?: number } = {},
): Promise<WpMedia[]> {
  const params: Record<string, string> = {
    per_page: String(Math.min(opts.perPage ?? 20, 100)),
    page: String(opts.page ?? 1),
    media_type: "image",
  };
  if (opts.search) params.search = opts.search;
  return wpGet<WpMedia[]>(env, "/media", params);
}

/** Importe un média WP vers la carte d'un voyage (photo_shares source='wordpress'). */
export async function importWordPressMedia(
  db: D1Database,
  env: Env,
  tripId: number,
  input: { media_id: number; lat?: number | null; lng?: number | null; place_id?: number | null },
): Promise<number> {
  const site = siteOf(env);
  if (!site) throw new Error("wordpress_not_configured");
  const media = await wpGet<WpMedia>(env, `/media/${input.media_id}`);
  if (!media.source_url) throw new Error("wordpress_media_no_source");
  // SSRF guard minimal : n'accepte que le site configuré ou son CDN (même host).
  const srcHost = new URL(media.source_url).host;
  const siteHost = new URL(site).host;
  if (srcHost !== siteHost) throw new Error("wordpress_media_offsite_refused");

  const caption = stripHtml(media.caption?.rendered ?? "") || media.alt_text || `Photo WordPress #${media.id}`;
  const res = await db
    .prepare(
      `INSERT INTO photo_shares (trip_id, place_id, source, url, thumbnail_url, caption, lat, lng, taken_at, wp_media_id)
       VALUES (?, ?, 'wordpress', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tripId,
      input.place_id ?? null,
      media.source_url,
      media.source_url,
      caption,
      input.lat ?? (typeof media.latitude === "number" ? media.latitude : null),
      input.lng ?? (typeof media.longitude === "number" ? media.longitude : null),
      media.date ?? null,
      media.id,
    )
    .run();
  const id = Number(res.meta.last_row_id);
  if (!Number.isFinite(id)) throw new Error("insert_failed");
  return id;
}

/** Articles récents avec image mise en avant (pour proposer des photos géolocalisables). */
export async function listWordPressPosts(env: Env, perPage = 10): Promise<WpPost[]> {
  return wpGet<WpPost[]>(env, "/posts", { per_page: String(Math.min(perPage, 50)), _embed: "wp:featuredmedia" });
}
