import { Hono } from "hono";
import type { Env } from "../env";
import { getShareByToken, getTrip } from "../db/client";
import { cachedJson } from "../lib/cache";
import { err } from "../lib/http";

const shared = new Hono<{ Bindings: Env }>();

// Page publique lecture seule. Edge-cachée 60 s (clé = URL avec token,
// le token est une capability inguessable : pas de fuite entre liens).
shared.get("/:token", async (c) =>
  cachedJson(c, 60, async () => {
    const row = await getShareByToken(c.env.DB, c.req.param("token"));
    if (!row) return err(c, "not_found", 404);
    const trip = await getTrip(c.env.DB, row.trip_id);
    if (!trip) return err(c, "not_found", 404);
    const db = c.env.DB;
    const [placesRes, sharesRes] = row.share_map || row.share_photos
      ? await db.batch([
          db.prepare("SELECT id, name, lat, lng, address, notes, image_url FROM places WHERE trip_id = ? AND lat IS NOT NULL AND lng IS NOT NULL").bind(trip.id),
          db.prepare("SELECT id, source, url, thumbnail_url, caption, lat, lng, author, taken_at FROM photo_shares WHERE trip_id = ?").bind(trip.id),
        ])
      : [{ results: [] }, { results: [] }];
    return c.json({
      trip: { id: trip.id, title: trip.title, description: trip.description, start_date: trip.start_date, end_date: trip.end_date, cover_image: trip.cover_image },
      places: row.share_map ? placesRes.results : [],
      photo_shares: row.share_photos ? sharesRes.results : [],
      permissions: { share_map: !!row.share_map, share_photos: !!row.share_photos },
    });
  }),
);

export default shared;
