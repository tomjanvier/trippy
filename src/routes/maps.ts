import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import { assertTripAccess, getPlace } from "../db/client";
import { userIdOf } from "../lib/access";
import { cachedJson } from "../lib/cache";
import {
  isValidLatLng,
  POI_CATEGORIES,
  poisInBbox,
  reverseGeocode,
  routeOsm,
  searchNominatim,
  searchPhoton,
} from "../lib/geo";
import { err } from "../lib/http";
import { notifyTrip } from "../lib/notify";
import { searchSchema } from "../lib/contracts";
import { fmtIssues } from "../lib/validate";

const mapsApi = new Hono<{ Bindings: Env }>();

/**
 * Enveloppe les appels upstream : une panne ou un refus de Nominatim/Overpass doit
 * répondre 502 avec la cause, jamais un 500 opaque (ni un throw non capté).
 */
async function upstream(c: { json: (b: unknown, s?: 400 | 502) => Response }, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const reason = e instanceof Error ? e.message : "unknown";
    return c.json({ error: "upstream_unavailable", reason }, 502);
  }
}

/** Recherche de lieux : Photon d'abord (rapide), Nominatim en complément. */
mapsApi.get("/search", async (c) => {
  const parsed = searchSchema.safeParse({ q: c.req.query("q") ?? "", limit: c.req.query("limit") ?? undefined });
  if (!parsed.success) return err(c, "bad_request", 400, { issues: fmtIssues(parsed.error) });
  const { q, limit } = parsed.data;
  const build = async () => {
    const [photon, nominatim] = await Promise.allSettled([searchPhoton(c.env, q, limit), searchNominatim(c.env, q, limit)]);
    const out = [
      ...(photon.status === "fulfilled" ? photon.value : []),
      ...(nominatim.status === "fulfilled" ? nominatim.value : []),
    ];
    // Dédupe par coordonnées proches (les deux moteurs se recoupent).
    const seen: typeof out = [];
    for (const p of out) {
      if (seen.some((s) => Math.abs(s.lat - p.lat) < 1e-4 && Math.abs(s.lng - p.lng) < 1e-4)) continue;
      seen.push(p);
    }
    if (!seen.length && photon.status === "rejected" && nominatim.status === "rejected") {
      // Les deux moteurs ont échoué : on le dit plutôt que de rendre un vide.
      return c.json({ error: "search_unavailable", reason: String(photon.reason ?? "").slice(0, 120) }, 502);
    }
    return c.json({ results: seen.slice(0, limit) });
  };
  // 24 h en edge : les noms de lieux changent rarement.
  return cachedJson(c, 86_400, build);
});

/** Géocoding inverse : nommer un point (utilisé au clic sur la carte). */
mapsApi.get("/reverse", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  if (!isValidLatLng(lat, lng)) return err(c, "bad_latlng", 400);
  return cachedJson(c, 86_400, async () => {
    const place = await reverseGeocode(c.env, lat, lng);
    if (!place) return err(c, "not_found", 404);
    return c.json({ place });
  });
});

/** Itinéraire entre les lieux d'un voyage (OSRM, sans clé). */
mapsApi.get("/trips/:id/route", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const profile = c.req.query("profile") === "walking" ? "walking" : c.req.query("profile") === "cycling" ? "cycling" : "driving";
  const { results } = await c.env.DB.prepare(
    `SELECT p.lat, p.lng FROM places p
     JOIN day_assignments a ON a.place_id = p.id JOIN days d ON d.id = a.day_id
     WHERE d.trip_id = ? AND p.lat IS NOT NULL AND p.lng IS NOT NULL
     GROUP BY p.id ORDER BY d.day_number, a.order_index, a.id`,
  ).bind(tripId).all<{ lat: number; lng: number }>();
  const points = results.map((r) => [r.lat, r.lng] as [number, number]);
  if (points.length < 2) return err(c, "need_two_places", 400);
  return upstream(c, async () => {
    const route = await routeOsm(c.env, points, profile);
    if (!route) return err(c, "route_failed", 502);
    return c.json({ profile, ...route, stops: points.length });
  });
});

/** POI par catégorie sur l'emprise d'un voyage (Overpass). */
mapsApi.get("/trips/:id/pois", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const category = c.req.query("category") ?? "restaurant";
  if (!POI_CATEGORIES.includes(category)) return err(c, "unknown_category", 400, { categories: POI_CATEGORIES });
  const { results } = await c.env.DB.prepare("SELECT lat, lng FROM places WHERE trip_id = ? AND lat IS NOT NULL AND lng IS NOT NULL").bind(tripId).all<{ lat: number; lng: number }>();
  if (!results.length) return err(c, "no_geolocated_places", 400);
  // Emprise des lieux, élargie, plafonnée pour ne pas surveyor le monde.
  const lats = results.map((r) => r.lat);
  const lngs = results.map((r) => r.lng);
  const pad = 0.02;
  const bbox: [number, number, number, number] = [
    Math.max(-90, Math.min(...lats) - pad),
    Math.max(-180, Math.min(...lngs) - pad),
    Math.min(90, Math.max(...lats) + pad),
    Math.min(180, Math.max(...lngs) + pad),
  ];
  if (bbox[2] - bbox[0] > 2 || bbox[3] - bbox[1] > 2) return err(c, "area_too_large", 400);
  return upstream(c, async () => {
    const pois = await poisInBbox(c.env, bbox, category);
    return c.json({ category, bbox, pois }, 200, { "cache-control": "private, max-age=600" });
  });
});

/** Ajout d'un lieu trouvé par la recherche (provenance OSM conservée). */
mapsApi.post("/trips/:id/places/from-search", requireAuth, async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!(await assertTripAccess(c.env.DB, tripId, userIdOf(c)))) return err(c, "not_found", 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    lat?: number;
    lng?: number;
    address?: string;
    category?: string;
    day_id?: number;
  };
  if (!body.name?.trim() || !isValidLatLng(body.lat, body.lng)) return err(c, "name_and_valid_coords_required", 400);
  const res = await c.env.DB.prepare("INSERT INTO places (trip_id, name, lat, lng, address, category) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(tripId, body.name.trim(), Number(body.lat), Number(body.lng), body.address ?? null, body.category ?? null).run();
  const place = await getPlace(c.env.DB, Number(res.meta.last_row_id));
  if (body.day_id) {
    const next = ((await c.env.DB.prepare("SELECT COALESCE(MAX(order_index), -1) AS m FROM day_assignments WHERE day_id = ?").bind(body.day_id).first<{ m: number }>())?.m ?? -1) + 1;
    await c.env.DB.prepare("INSERT INTO day_assignments (day_id, place_id, order_index) VALUES (?, ?, ?)").bind(body.day_id, place!.id, next).run();
  }
  notifyTrip(c, tripId, { type: "place.created", tripId, place });
  return c.json({ place }, 200);
});

export default mapsApi;