import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { assertTripAccess } from "../db/client";
import { userIdOf } from "../lib/access";
import { err, readJson } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import { fmtIssues, wpPinSchema } from "../lib/validate";
import { importWordPressMedia, listWordPressMedia, listWordPressPosts } from "../photos/wordpress";

/** GET /api/photos/wordpress/* (browse du site WP configuré). */
export const wordpressApi = new Hono<{ Bindings: Env }>();

wordpressApi.get("/media", requireAuth, async (c) => {
  try {
    const media = await listWordPressMedia(c.env, {
      search: c.req.query("search") ?? undefined,
      page: Number(c.req.query("page") || 1),
    });
    return c.json(
      { media: media.map((m) => ({ id: m.id, url: m.source_url, alt: m.alt_text, date: m.date, mime: m.mime_type })) },
      200,
      { "cache-control": "private, max-age=60" },
    );
  } catch (e) {
    const msg = (e as Error).message;
    return err(c, msg, msg === "wordpress_not_configured" ? 400 : 502);
  }
});

wordpressApi.get("/posts", requireAuth, async (c) => {
  try {
    const posts = await listWordPressPosts(c.env);
    return c.json(
      {
        posts: posts.map((p) => ({
          id: p.id,
          link: p.link,
          title: p.title?.rendered?.replace(/<[^>]*>/g, "") ?? "",
          image: p._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? null,
        })),
      },
      200,
      { "cache-control": "private, max-age=60" },
    );
  } catch (e) {
    return err(c, (e as Error).message, 502);
  }
});

/** POST /api/trips/:id/photos/wordpress (import + épingle). */
export const wordpressNested = new Hono<{ Bindings: Env }>();

wordpressNested.post("/:id/photos/wordpress", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  const trip = await assertTripAccess(c.env.DB, tripId, userIdOf(c));
  if (!trip) return err(c, "not_found", 404);
  const parsed = wpPinSchema.safeParse(await readJson(c));
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const b = parsed.data;
  try {
    const id = await importWordPressMedia(c.env.DB, c.env, tripId, {
      media_id: b.media_id,
      lat: b.lat ?? null,
      lng: b.lng ?? null,
      place_id: b.place_id ?? null,
    });
    notifyTrip(c, tripId, { type: "photo.created", tripId, source: "wordpress" });
    return c.json({ id }, 200);
  } catch (e) {
    const msg = (e as Error).message;
    return err(c, msg, msg === "wordpress_not_configured" ? 400 : 502);
  }
});
