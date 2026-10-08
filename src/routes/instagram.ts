import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { assertTripAccess } from "../db/client";
import { userIdOf } from "../lib/access";
import { cachedJson } from "../lib/cache";
import { clientIp, err, readJson } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import { rateLimit } from "../lib/ratelimit";
import { fmtIssues, instaPinSchema } from "../lib/validate";
import { fetchInstagramOEmbed, parseInstagramUrl, saveInstagramShare } from "../photos/instagram";

const OEMBED_KV_TTL = 24 * 3600;

/** GET /api/photos/instagram/* (données oEmbed publiques, edge-cache 10 min). */
export const instagramApi = new Hono<{ Bindings: Env }>();

instagramApi.get("/preview", async (c) => {
  const rl = await rateLimit(c.env, `ig:${clientIp(c)}`, 30, 60);
  if (!rl.ok) return err(c, "rate_limited", 429);
  const url = c.req.query("url") ?? "";
  const shortcode = parseInstagramUrl(url);
  if (!shortcode) return err(c, "bad_instagram_url", 400);
  return cachedJson(c, 600, async () => {
    const kvKey = `ig:oembed:${shortcode}`;
    const cached = await c.env.SESSIONS.get(kvKey).catch(() => null);
    if (cached) return c.json({ embed: JSON.parse(cached), cached: true });
    const embed = await fetchInstagramOEmbed(url);
    if (!embed) return err(c, "oembed_failed", 502);
    c.executionCtx.waitUntil(c.env.SESSIONS.put(kvKey, JSON.stringify(embed), { expirationTtl: OEMBED_KV_TTL }).catch(() => null));
    return c.json({ embed, cached: false });
  });
});

/** POST /api/trips/:id/photos/instagram (épingle sur la carte du voyage). */
export const instagramNested = new Hono<{ Bindings: Env }>();

instagramNested.post("/:id/photos/instagram", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, tripId, userIdOf(c));
  if (!trip) return err(c, "not_found", 404);
  const parsed = instaPinSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  if (!parseInstagramUrl(b.url)) return err(c, "bad_instagram_url", 400);
  const id = await saveInstagramShare(c.env.DB, tripId, {
    url: b.url,
    lat: b.lat ?? null,
    lng: b.lng ?? null,
    place_id: b.place_id ?? null,
    caption: b.caption,
  });
  notifyTrip(c, tripId, { type: "photo.created", tripId, source: "instagram" });
  return c.json({ id }, 200);
});
