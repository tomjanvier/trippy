import { Hono } from "hono";
import type { Env } from "../env";
import { assertTripAccess, getShareByToken } from "../db/client";
import { userIdOf } from "../lib/access";
import { cachedJson } from "../lib/cache";
import { openMeteoUrl } from "../lib/export";
import { err } from "../lib/http";

/**
 * Météo du voyage via Open-Meteo (sans clé) : centroïde des lieux
 * géolocalisés + fenêtre couverte par les jours datés (sinon J..J+7).
 * Edge-cache 1 h via ?share=, navigateur seul sous session.
 */
export const weatherNested = new Hono<{ Bindings: Env }>();

weatherNested.get("/:id/weather", async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!Number.isFinite(tripId)) return err(c, "not_found", 404);
  const shareParam = c.req.query("share");
  let viaShare = false;
  if (shareParam) {
    const row = await getShareByToken(c.env.DB, shareParam);
    if (!row || row.trip_id !== tripId || !row.share_map) return err(c, "unauthorized", 401);
    viaShare = true;
  } else if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) {
    return err(c, "unauthorized", 401);
  }

  const build = async () => {
    const batchRes = await c.env.DB.batch([
      c.env.DB.prepare("SELECT lat, lng FROM places WHERE trip_id = ? AND lat IS NOT NULL AND lng IS NOT NULL").bind(tripId),
      c.env.DB.prepare("SELECT MIN(date) AS dmin, MAX(date) AS dmax FROM days WHERE trip_id = ? AND date IS NOT NULL").bind(tripId),
    ]);
    const ptsRes = batchRes[0]!;
    const datesRes = batchRes[1]!;
    const pts = ptsRes.results as unknown as { lat: number; lng: number }[];
    if (!pts.length) return err(c, "no_geolocated_places", 400);
    const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
    const lng = pts.reduce((a, p) => a + p.lng, 0) / pts.length;
    const range = datesRes.results[0] as unknown as { dmin: string | null; dmax: string | null };
    const today = new Date().toISOString().slice(0, 10);
    const start = (range.dmin ?? today).slice(0, 10);
    const end = (range.dmax ?? new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)).slice(0, 10);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(openMeteoUrl(lat, lng, start, end), {
        signal: ctrl.signal,
        headers: { "user-agent": "trek-cloudflare/0.2 (+weather)" },
      });
      if (!res.ok) return err(c, "weather_upstream_error", 502);
      const body = (await res.json()) as { daily?: Record<string, (number | string | null)[]> };
      if (!body.daily?.time) return err(c, "weather_upstream_error", 502);
      return c.json(
        { centroid: { lat, lng }, start, end, daily: body.daily },
        200,
        viaShare ? {} : { "cache-control": "private, max-age=600" },
      );
    } catch {
      return err(c, "weather_upstream_error", 502);
    } finally {
      clearTimeout(t);
    }
  };
  return viaShare ? cachedJson(c, 3600, build) : build();
});
