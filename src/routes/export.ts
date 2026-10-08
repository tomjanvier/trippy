import { Hono } from "hono";
import type { Env } from "../env";
import { assertTripAccess, getShareByToken, type PhotoShareRow, type TripRow } from "../db/client";
import { userIdOf } from "../lib/access";
import { buildGpx, buildIcs, type GpxPoint, type IcsDay } from "../lib/export";
import { err, type AppContext } from "../lib/http";

/** Exports publics/partagés : session membre OU ?share=<token> (share_map=1). */
export const exportNested = new Hono<{ Bindings: Env }>();

async function resolveTrip(c: AppContext, tripId: number): Promise<{ trip: TripRow; viaShare: boolean; includePhotos: boolean } | null> {
  const shareParam = c.req.query("share");
  if (shareParam) {
    const row = await getShareByToken(c.env.DB, shareParam);
    if (!row || row.trip_id !== tripId || !row.share_map) return null;
    const trip = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first<TripRow>();
    if (!trip) return null;
    return { trip, viaShare: true, includePhotos: !!row.share_photos };
  }
  const uid = userIdOf(c);
  const trip = uid ? await assertTripAccess(c.env.DB, tripId, uid) : null;
  if (!trip) return null;
  return { trip, viaShare: false, includePhotos: true };
}

exportNested.get("/:id/export.gpx", async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!Number.isFinite(tripId)) return err(c, "not_found", 404);
  const authz = await resolveTrip(c, tripId);
  if (!authz) return err(c, "unauthorized", 401);
  const trip = authz.trip;
  const batchRes = await c.env.DB.batch([
    c.env.DB.prepare("SELECT name, lat, lng, address FROM places WHERE trip_id = ? AND lat IS NOT NULL AND lng IS NOT NULL").bind(tripId),
    c.env.DB.prepare("SELECT source, caption, lat, lng FROM photo_shares WHERE trip_id = ? AND lat IS NOT NULL AND lng IS NOT NULL").bind(tripId),
  ]);
  const placesRes = batchRes[0]!;
  const sharesRes = batchRes[1]!;
  const points: GpxPoint[] = (placesRes.results as unknown as { name: string; lat: number; lng: number; address: string | null }[]).map((p) => ({
    lat: p.lat,
    lng: p.lng,
    name: p.name,
    desc: p.address,
    kind: "place",
  }));
  if (authz.includePhotos) {
    for (const s of sharesRes.results as unknown as PhotoShareRow[]) {
      if (s.lat === null || s.lng === null) continue;
      points.push({ lat: s.lat, lng: s.lng, name: s.caption?.slice(0, 120) || `Photo ${s.source}`, kind: `photo:${s.source}` });
    }
  }
  const gpx = buildGpx(trip.title, points);
  return new Response(gpx, {
    headers: {
      "content-type": "application/gpx+xml; charset=utf-8",
      "content-disposition": `attachment; filename="trip-${tripId}.gpx"`,
      "cache-control": authz.viaShare ? "public, max-age=300" : "private, max-age=300",
    },
  });
});

exportNested.get("/:id/calendar.ics", async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!Number.isFinite(tripId)) return err(c, "not_found", 404);
  const authz = await resolveTrip(c, tripId);
  if (!authz) return err(c, "unauthorized", 401);
  const trip = authz.trip;
  const { results } = await c.env.DB.prepare(
    `SELECT d.day_number, d.date, d.title, p.name AS place_name
     FROM days d LEFT JOIN places p ON p.day_id = d.id
     WHERE d.trip_id = ? ORDER BY d.day_number, p.id`,
  ).bind(tripId).all<{ day_number: number; date: string | null; title: string | null; place_name: string | null }>();
  const byNum = new Map<number, { date: string | null; title: string | null; places: string[] }>();
  for (const r of results) {
    let e = byNum.get(r.day_number);
    if (!e) {
      e = { date: r.date, title: r.title, places: [] };
      byNum.set(r.day_number, e);
    }
    if (r.place_name) e.places.push(r.place_name);
  }
  const days: IcsDay[] = [...byNum].filter(([, e]) => e.date).map(([n, e]) => ({ n, date: e.date as string, title: e.title, places: e.places }));
  const { ics, count } = buildIcs(trip.title, tripId, days);
  if (!count) return err(c, "no_dated_days", 400);
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="trip-${tripId}.ics"`,
      "cache-control": authz.viaShare ? "public, max-age=300" : "private, max-age=300",
    },
  });
});
