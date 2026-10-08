import type { Env } from "../env";

/**
 * Clients des API géographiques publiques, sans clé, comme le TREK d'origine :
 * - Nominatim : recherche + géocoding inverse (OSM)
 * - Photon    : autocompl��tion (recherche plus vive)
 * - OSRM      : distance / itinéraire
 * - Overpass  : POIs par catégorie sur une emprise
 *
 * Règles communes à tous ces appels : timeout, plafond de taille de réponse,
 * validation des bornes, et User-Agent identifiant (Nominatim l'exige).
 */

const UA = "trek-cloudflare/0.3 (self-hosted travel planner)";

export interface FetchOpts {
  timeoutMs?: number;
  maxBytes?: number;
  /** Corps de requête (POST Overpass). */
  body?: string;
  contentType?: string;
  cacheTtlSec?: number;
}

/** fetch borné : timeout + plafond de taille. Rethrow simple, l'appelant décide. */
export async function fetchCapped(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 10_000, maxBytes = 1_500_000, body, contentType } = opts;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      body,
      signal: ctrl.signal,
      headers: { "user-agent": UA, ...(contentType ? { "content-type": contentType } : {}) },
    });
    if (!res.ok) throw new Error(`upstream_${res.status}`);
    // Le plafond est vérifié après coup : les API concernées renvoient du JSON
    // compact ; au-delà on échoue plutôt que de consommer la mémoire du Worker.
    const text = await res.text();
    if (text.length > maxBytes) throw new Error("upstream_response_too_large");
    return new Response(text, { headers: { "content-type": "application/json" } });
  } finally {
    clearTimeout(t);
  }
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  const la = Number(lat);
  const ln = Number(lng);
  return Number.isFinite(la) && Number.isFinite(ln) && la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
}

// ---------- Nominatim : recherche ----------
export interface PlaceSuggestion {
  osm_id: string;
  osm_type: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
  type?: string;
  address?: string | null;
}

interface NominatimItem {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  category?: string;
  type?: string;
  address?: Record<string, string>;
}

export async function searchNominatim(env: Env, q: string, limit = 8): Promise<PlaceSuggestion[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(Math.min(limit, 25)));
  const res = await fetchCapped(url.toString(), { timeoutMs: 10_000 });
  const items = (await res.json()) as NominatimItem[];
  return items
    .filter((i) => i.lat && i.lon && isValidLatLng(i.lat, i.lon))
    .map((i) => ({
      osm_id: `${i.osm_type ?? "node"}/${i.osm_id ?? i.place_id ?? 0}`,
      osm_type: i.osm_type ?? "node",
      name: i.name ?? i.display_name?.split(",")[0]?.trim() ?? "Sans nom",
      lat: Number(i.lat),
      lng: Number(i.lon),
      category: i.category,
      type: i.type,
      address: i.display_name ?? null,
    }));
}

// ---------- Photon : autocomplétion ----------
interface PhotonFeature {
  properties?: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    state?: string;
    country?: string;
    type?: string;
    category?: string;
  };
  geometry?: { coordinates?: [number, number] };
}

export async function searchPhoton(env: Env, q: string, limit = 8): Promise<PlaceSuggestion[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(Math.min(limit, 25)));
  const res = await fetchCapped(url.toString(), { timeoutMs: 8_000 });
  const body = (await res.json()) as { features?: PhotonFeature[] };
  return (body.features ?? [])
    .filter((f) => f.geometry?.coordinates)
    .map((f) => {
      const p = f.properties ?? {};
      const [lng, lat] = f.geometry!.coordinates!;
      const where = [p.housenumber, p.street, p.postcode, p.city, p.state, p.country].filter(Boolean).join(", ");
      return {
        osm_id: `${p.osm_type ?? "node"}/${p.osm_id ?? 0}`,
        osm_type: p.osm_type ?? "node",
        name: p.name || where.split(",")[0] || "Sans nom",
        lat: lat!,
        lng: lng!,
        category: p.category,
        type: p.type,
        address: where || null,
      };
    });
}

// ---------- Nominatim : géocoding inverse ----------
export async function reverseGeocode(env: Env, lat: number, lng: number): Promise<{ name: string; address: string | null } | null> {
  if (!isValidLatLng(lat, lng)) return null;
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "18");
  const res = await fetchCapped(url.toString(), { timeoutMs: 10_000 });
  const item = (await res.json()) as NominatimItem & { name?: string };
  const name = item.name ?? item.address?.road ?? item.display_name?.split(",")[0]?.trim();
  if (!name) return null;
  return { name, address: item.display_name ?? null };
}

// ---------- OSRM : distance + itinéraire ----------
export interface RouteLeg {
  distanceM: number;
  durationS: number;
}
export interface RouteResult {
  distanceM: number;
  durationS: number;
  geometry: [number, number][];
  legs: RouteLeg[];
}

export async function routeOsm(
  env: Env,
  points: [number, number][],
  profile: "driving" | "walking" | "cycling",
): Promise<RouteResult | null> {
  if (points.length < 2 || points.length > 100) return null;
  if (!points.every(([lat, lng]) => isValidLatLng(lat, lng))) return null;
  const coordStr = points.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const base = profile === "driving" ? "https://router.project-osrm.org/route/v1/driving" : profile === "walking" ? "https://routing.openstreetmap.de/routed-foot/route/v1/driving" : "https://routing.openstreetmap.de/routed-bike/route/v1/driving";
  const url = `${base}/${coordStr}?overview=full&geometries=geojson&steps=false`;
  const res = await fetchCapped(url, { timeoutMs: 15_000, maxBytes: 3_000_000 });
  const body = (await res.json()) as {
    code?: string;
    routes?: { distance: number; duration: number; geometry?: { coordinates?: [number, number][] }; legs?: { distance: number; duration: number }[] }[];
  };
  if (body.code !== "Ok" || !body.routes?.[0]) return null;
  const r = body.routes[0];
  return {
    distanceM: Math.round(r.distance),
    durationS: Math.round(r.duration),
    geometry: r.geometry?.coordinates ?? [],
    legs: (r.legs ?? []).map((l) => ({ distanceM: Math.round(l.distance), durationS: Math.round(l.duration) })),
  };
}

// ---------- Overpass : POIs sur une emprise ----------
/** L'endpoint public est souvent saturé (504/521) : on bascule sur un miroir. */
const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const CATEGORY_TAGS: Record<string, string> = {
  restaurant: '["amenity"="restaurant"]',
  cafe: '["amenity"="cafe"]',
  bar: '["amenity"="bar"]',
  hotel: '["tourism"="hotel"]',
  museum: '["tourism"="museum"]',
  viewpoint: '["tourism"="viewpoint"]',
  park: '["leisure"="park"]',
  beach: '["natural"="beach"]',
  shop: '["shop"]',
  pharmacy: '["amenity"="pharmacy"]',
  bank: '["amenity"="bank"]',
  fuel: '["amenity"="fuel"]',
};

export interface Poi {
  osm_id: string;
  name: string | null;
  lat: number;
  lng: number;
  category: string;
  tags: Record<string, string>;
}

/** Tags conservés : le reste est inutile au client et gonfle la réponse. */
const POI_TAG_WHITELIST = ["name", "name:fr", "cuisine", "opening_hours", "website", "phone", "addr:city", "tourism", "amenity", "leisure", "natural", "shop"];

function trimTags(tags: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of POI_TAG_WHITELIST) {
    const v = tags?.[k];
    if (v) out[k] = v.slice(0, 120);
  }
  return out;
}

export async function poisInBbox(
  env: Env,
  bbox: [number, number, number, number],
  category: string,
): Promise<Poi[]> {
  const [south, west, north, east] = bbox;
  if ([south, west, north, east].some((v) => !Number.isFinite(v))) return [];
  if (south >= north || west >= east) return [];
  const sel = CATEGORY_TAGS[category];
  if (!sel) return [];
  // 150 éléments max : au-delà la réponse dépasse inutilement la mémoire du Worker.
  const query = `[out:json][timeout:20];nwr${sel}(${south},${west},${north},${east});out center 150;`;
  const body = new URLSearchParams({ data: query }).toString();
  let lastError: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchCapped(endpoint, {
        timeoutMs: 25_000,
        maxBytes: 1_500_000,
        body,
        contentType: "application/x-www-form-urlencoded",
      });
      return parseOverpass(await res.json(), category);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("overpass_unavailable");
}

interface OverpassBody {
  elements?: {
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
  }[];
}

function parseOverpass(body: OverpassBody, category: string): Poi[] {
  return (body.elements ?? [])
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat === undefined || lng === undefined) return null;
      return {
        osm_id: `${el.type}/${el.id}`,
        name: el.tags?.["name"] ?? el.tags?.["name:fr"] ?? null,
        lat,
        lng,
        category,
        tags: trimTags(el.tags),
      };
    })
    .filter((x): x is Poi => x !== null);
}

export const POI_CATEGORIES = Object.keys(CATEGORY_TAGS);