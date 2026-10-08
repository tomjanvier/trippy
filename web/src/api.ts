/**
 * Client API typé — parle exactement aux routes du Worker (src/routes/*).
 * Aucune dépendance : fetch natif + token JWT en localStorage (le cookie
 * httpOnly est posé par le Worker, le Bearer sert au reload).
 */
import { enqueue } from "./offline";

export interface User {
  id: number;
  username: string;
  email: string;
  role: string;
}

export interface Trip {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  currency: string;
  cover_image: string | null;
  is_archived: number;
  created_at: string;
  updated_at: string;
  places_count?: number;
  photos_count?: number;
}

export interface Day {
  id: number;
  trip_id: number;
  day_number: number;
  date: string | null;
  title: string | null;
  notes: string | null;
}

export interface Place {
  id: number;
  trip_id: number;
  day_id: number | null;
  name: string;
  description: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  category: string | null;
  notes: string | null;
  image_url: string | null;
  website: string | null;
}

export type Source = "upload" | "instagram" | "wordpress";

export interface PhotoShare {
  id: number;
  trip_id?: number;
  place_id: number | null;
  source: Source;
  url: string;
  thumbnail_url: string | null;
  caption: string | null;
  lat: number | null;
  lng: number | null;
  author: string | null;
  taken_at: string | null;
}

export interface Share {
  token: string;
  share_map: number;
  share_photos: number;
  expires_at: string | null;
}

export interface MapPhotoFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: number;
    source: Source;
    url: string;
    thumbnail: string | null;
    caption: string | null;
    author: string | null;
    place_id: number | null;
  };
}

export interface WpMedia {
  id: number;
  url: string;
  alt: string | null;
  date: string | null;
  mime: string | null;
}

export interface Assignment {
  id: number;
  day_id: number;
  place_id: number;
  order_index: number;
  notes: string | null;
}

export interface PlanItem extends Place {
  assignment_id: number;
  /** Redondant avec `id` (celui du lieu) mais explicite dans la réponse de l'API. */
  place_id: number;
  order_index: number;
}

export interface PlanDay extends Day {
  items: PlanItem[];
}

export interface Plan {
  days: PlanDay[];
  unassigned: Place[];
}

export interface Reservation {
  id: number;
  trip_id: number;
  day_id: number | null;
  place_id: number | null;
  title: string;
  type: string;
  status: string;
  reservation_time: string | null;
  reservation_end_time: string | null;
  location: string | null;
  confirmation_number: string | null;
  notes: string | null;
  cost_cents: number | null;
  currency: string | null;
  day_number?: number | null;
  place_name?: string | null;
}

export interface BudgetItem {
  id: number;
  category: string;
  name: string;
  total_cents: number;
  currency: string | null;
  persons: number | null;
  days: number | null;
  note: string | null;
  sort_order: number;
  members?: { user_id: number; username: string; share_cents: number }[];
}

export interface PackingItem {
  id: number;
  name: string;
  checked: number;
  category: string | null;
  sort_order: number;
}

export interface TodoItem {
  id: number;
  name: string;
  checked: number;
  category: string | null;
  description: string | null;
  due_date: string | null;
  priority: number;
  sort_order: number;
}

const TOKEN_KEY = "trek_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* stockage indisponible */
  }
}

export class ApiError extends Error {
  status: number;
  /** true quand la requête a échoué faute de réseau et a été mise en file. */
  queued: boolean;
  constructor(status: number, message: string, queued = false) {
    super(message);
    this.status = status;
    this.queued = queued;
  }
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

async function request<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  let isJson = false;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
    isJson = true;
  }

  const mutating = MUTATING.has(method);
  // Clé d'idempotence stable : c'est elle qui empêche un rejeu de double-appliquer.
  const idemKey = mutating ? newIdempotencyKey() : "";
  if (idemKey) headers["X-Idempotency-Key"] = idemKey;

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: "include" });
  } catch (e) {
    // Coupure réseau : les écritures sont mises en file puis rejouées.
    if (mutating && isJson) {
      await enqueue({ key: idemKey, method, path, body: JSON.stringify(body ?? {}), createdAt: Date.now() });
      throw new ApiError(0, "Hors ligne — modification enregistrée, elle partira au retour du réseau.", true);
    }
    throw new ApiError(0, e instanceof Error ? e.message : "network_error");
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg =
      (data as { error?: string } | undefined)?.error ??
      (typeof data === "string" ? text.slice(0, 120) : `HTTP ${res.status}`);
    throw new ApiError(res.status, msg);
  }
  if (opts.raw) return data as T;
  return data as T;
}

/** Le fallback SPA renvoie index.html pour une route inconnue : on n'en veut pas comme JSON. */
function safeJson(text: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------- auth ----------
export const auth = {
  register: (b: { email: string; password: string; username?: string }) =>
    request<{ user: User; token: string }>("POST", "/api/auth/register", b).then((r) => {
      setToken(r.token);
      return r.user;
    }),
  login: (b: { email: string; password: string; remember_me?: boolean }) =>
    request<{ user: User; token: string }>("POST", "/api/auth/login", b).then((r) => {
      setToken(r.token);
      return r.user;
    }),
  me: () => request<{ user: User }>("GET", "/api/auth/me").then((r) => r.user),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout").then(() => setToken(null)),
};

// ---------- trips ----------
export const trips = {
  list: (cursor?: string) =>
    request<{ trips: Trip[]; nextCursor: string | null }>("GET", `/api/trips${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  create: (b: { title: string; description?: string; start_date?: string; end_date?: string; days_count?: number }) =>
    request<{ trip: Trip }>("POST", "/api/trips", b).then((r) => r.trip),
  detail: (id: number) =>
    request<{ trip: Trip; days: Day[]; places: Place[]; photo_shares_count: number; share: Share | null }>("GET", `/api/trips/${id}`),
  update: (id: number, b: Partial<{ title: string; description: string; start_date: string; end_date: string; is_archived: number }>) =>
    request<{ trip: Trip }>("PATCH", `/api/trips/${id}`, b).then((r) => r.trip),
  remove: (id: number) => request<{ ok: true }>("DELETE", `/api/trips/${id}`),
  days: (id: number) => request<{ days: Day[] }>("GET", `/api/trips/${id}/days`).then((r) => r.days),
  addDay: (id: number, b: { title?: string; date?: string }) => request<{ day: Day }>("POST", `/api/trips/${id}/days`, b).then((r) => r.day),
  updateDay: (dayId: number, b: { title?: string | null; date?: string | null; day_number?: number }) =>
    request<{ day: Day }>("PATCH", `/api/days/${dayId}`, b).then((r) => r.day),
  deleteDay: (dayId: number) => request<{ ok: true }>("DELETE", `/api/days/${dayId}`),
  mapPhotos: (id: number, shareToken?: string, sources?: string[]) => {
    const p = new URLSearchParams();
    if (sources?.length) p.set("sources", sources.join(","));
    if (shareToken) p.set("share", shareToken);
    const q = p.toString();
    return request<{ type: string; features: MapPhotoFeature[] }>("GET", `/api/trips/${id}/map-photos${q ? `?${q}` : ""}`);
  },
  weather: (id: number) =>
    request<{ centroid: { lat: number; lng: number }; start: string; end: string; daily: Record<string, (number | string | null)[]> }>(
      "GET",
      `/api/trips/${id}/weather`,
    ),
  // ---------- partage ----------
  share: (id: number) => request<Share & { url: string }>("POST", `/api/trips/${id}/share`),
  shareInfo: (id: number) => request<{ share: Share }>("GET", `/api/trips/${id}/share`).then((r) => r.share),
  patchShare: (id: number, b: { share_map?: number; share_photos?: number; expires_at?: string | null }) =>
    request<{ share: Share }>("PATCH", `/api/trips/${id}/share`, b).then((r) => r.share),
  revokeShare: (id: number) => request<{ ok: true }>("DELETE", `/api/trips/${id}/share`),
  // ---------- photos ----------
  photoShares: (id: number, source?: Source) =>
    request<{ photo_shares: PhotoShare[] }>("GET", `/api/trips/${id}/photo-shares${source ? `?source=${source}` : ""}`).then(
      (r) => r.photo_shares,
    ),
  deletePhotoShare: (id: number, shareId: number) => request<{ ok: true }>("DELETE", `/api/trips/${id}/photo-shares/${shareId}`),
  updatePhotoShare: (id: number, shareId: number, b: { lat?: number | null; lng?: number | null; caption?: string | null; place_id?: number | null }) =>
    request<{ photo_share: PhotoShare }>("PATCH", `/api/trips/${id}/photo-shares/${shareId}`, b).then((r) => r.photo_share),
  uploadPhoto: (id: number, form: FormData) =>
    request<{ id: number; url: string }>("POST", `/api/trips/${id}/photos`, form).then((r) => r.id),
  deletePhoto: (id: number, photoId: number) => request<{ ok: true }>("DELETE", `/api/trips/${id}/photos/${photoId}`),
  // ---------- photos externes ----------
  previewInstagram: (url: string) =>
    request<{ embed: { thumbnail_url: string | null; title: string | null; author_name: string | null }; cached: boolean }>(
      "GET",
      `/api/photos/instagram/preview?url=${encodeURIComponent(url)}`,
    ),
  pinInstagram: (id: number, b: { url: string; lat?: number | null; lng?: number | null; caption?: string; place_id?: number | null }) =>
    request<{ id: number }>("POST", `/api/trips/${id}/photos/instagram`, b).then((r) => r.id),
  wpMedia: (search?: string) =>
    request<{ media: WpMedia[] }>("GET", `/api/photos/wordpress/media${search ? `?search=${encodeURIComponent(search)}` : ""}`).then(
      (r) => r.media,
    ),
  pinWordPress: (id: number, b: { media_id: number; lat?: number | null; lng?: number | null }) =>
    request<{ id: number }>("POST", `/api/trips/${id}/photos/wordpress`, b).then((r) => r.id),
  // ---------- plan (ordre du jour) ----------
  plan: (id: number) => request<Plan>("GET", `/api/trips/${id}/plan`),
  assign: (id: number, b: { day_id: number; place_id: number }) =>
    request<{ assignment: Assignment }>("POST", `/api/trips/${id}/assignments`, b).then((r) => r.assignment),
  unassign: (id: number, assignmentId: number) =>
    request<{ ok: true }>("DELETE", `/api/trips/${id}/assignments/${assignmentId}`),
  moveAssignment: (id: number, assignmentId: number, dayId: number) =>
    request<{ assignment: Assignment }>("PATCH", `/api/trips/${id}/assignments/${assignmentId}`, { day_id: dayId }),
  reorderDay: (id: number, dayId: number, placeIds: number[]) =>
    request<{ ok: true }>("POST", `/api/trips/${id}/assignments/reorder?day_id=${dayId}`, { place_ids: placeIds }),
  // ---------- réservations / hébergements ----------
  reservations: (id: number) => request<{ reservations: Reservation[] }>("GET", `/api/trips/${id}/reservations`).then((r) => r.reservations),
  addReservation: (id: number, b: Record<string, unknown>) =>
    request<{ reservation: Reservation }>("POST", `/api/trips/${id}/reservations`, b).then((r) => r.reservation),
  updateReservation: (id: number, resId: number, b: Record<string, unknown>) =>
    request<{ reservation: Reservation }>("PATCH", `/api/trips/${id}/reservations/${resId}`, b).then((r) => r.reservation),
  deleteReservation: (id: number, resId: number) => request<{ ok: true }>("DELETE", `/api/trips/${id}/reservations/${resId}`),
  accommodations: (id: number) =>
    request<{ accommodations: Record<string, unknown>[] }>("GET", `/api/trips/${id}/accommodations`).then((r) => r.accommodations),
  addAccommodation: (id: number, b: Record<string, unknown>) =>
    request<{ accommodation: Record<string, unknown> }>("POST", `/api/trips/${id}/accommodations`, b).then((r) => r.accommodation),
  deleteAccommodation: (id: number, accId: number) => request<{ ok: true }>("DELETE", `/api/trips/${id}/accommodations/${accId}`),
  // ---------- budget / packing / todos ----------
  budget: (id: number) =>
    request<{ budget_items: BudgetItem[]; total_cents: number }>("GET", `/api/trips/${id}/budget`),
  addBudgetItem: (id: number, b: Record<string, unknown>) =>
    request<{ budget_item: BudgetItem }>("POST", `/api/trips/${id}/budget`, b).then((r) => r.budget_item),
  updateBudgetItem: (id: number, itemId: number, b: Record<string, unknown>) =>
    request<{ budget_item: BudgetItem }>("PATCH", `/api/trips/${id}/budget/${itemId}`, b).then((r) => r.budget_item),
  deleteBudgetItem: (id: number, itemId: number) => request<{ ok: true }>("DELETE", `/api/trips/${id}/budget/${itemId}`),
  packing: (id: number) =>
    request<{ packing_items: PackingItem[]; total: number; checked: number }>("GET", `/api/trips/${id}/packing`),
  addPackingItem: (id: number, b: Record<string, unknown>) =>
    request<{ packing_item: PackingItem }>("POST", `/api/trips/${id}/packing`, b).then((r) => r.packing_item),
  updatePackingItem: (id: number, itemId: number, b: Record<string, unknown>) =>
    request<{ packing_item: PackingItem }>("PATCH", `/api/trips/${id}/packing/${itemId}`, b).then((r) => r.packing_item),
  deletePackingItem: (id: number, itemId: number) => request<{ ok: true }>("DELETE", `/api/trips/${id}/packing/${itemId}`),
  todos: (id: number) => request<{ todos: TodoItem[] }>("GET", `/api/trips/${id}/todos`).then((r) => r.todos),
  addTodo: (id: number, b: Record<string, unknown>) =>
    request<{ todo: TodoItem }>("POST", `/api/trips/${id}/todos`, b).then((r) => r.todo),
  updateTodo: (id: number, todoId: number, b: Record<string, unknown>) =>
    request<{ todo: TodoItem }>("PATCH", `/api/trips/${id}/todos/${todoId}`, b).then((r) => r.todo),
  deleteTodo: (id: number, todoId: number) => request<{ ok: true }>("DELETE", `/api/trips/${id}/todos/${todoId}`),
};

// ---------- lieux ----------
export const places = {
  list: (tripId: number, q?: { search?: string; day_id?: number }) => {
    const p = new URLSearchParams();
    if (q?.search) p.set("search", q.search);
    if (q?.day_id) p.set("day_id", String(q.day_id));
    const s = p.toString();
    return request<{ places: Place[] }>("GET", `/api/trips/${tripId}/places${s ? `?${s}` : ""}`).then((r) => r.places);
  },
  create: (tripId: number, b: { name: string; lat?: number | null; lng?: number | null; address?: string; day_id?: number | null; notes?: string }) =>
    request<{ place: Place }>("POST", `/api/trips/${tripId}/places`, b).then((r) => r.place),
  bulk: (tripId: number, items: { name: string; lat?: number | null; lng?: number | null; day_id?: number | null; notes?: string }[]) =>
    request<{ inserted: number; places: Place[] }>("POST", `/api/trips/${tripId}/places/bulk`, { places: items }).then((r) => r.inserted),
  update: (placeId: number, b: Partial<{ name: string; lat: number | null; lng: number | null; day_id: number | null; notes: string }>) =>
    request<{ place: Place }>("PATCH", `/api/places/${placeId}`, b).then((r) => r.place),
  remove: (placeId: number) => request<{ ok: true }>("DELETE", `/api/places/${placeId}`),
};

// ---------- carte : recherche, routes, POI ----------
export interface SearchResult {
  osm_id: string;
  osm_type: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
  type?: string;
  address?: string | null;
}

export interface Poi {
  osm_id: string;
  name: string | null;
  lat: number;
  lng: number;
  category: string;
  tags: Record<string, string>;
}

export interface RouteResult {
  profile: string;
  distanceM: number;
  durationS: number;
  geometry: [number, number][];
  stops: number;
}

export const maps = {
  search: (q: string) => request<{ results: SearchResult[] }>("GET", `/api/maps/search?q=${encodeURIComponent(q)}`).then((r) => r.results),
  reverse: (lat: number, lng: number) =>
    request<{ place: { name: string; address: string | null } }>("GET", `/api/maps/reverse?lat=${lat}&lng=${lng}`).then((r) => r.place),
  route: (id: number, profile: "driving" | "walking" | "cycling") =>
    request<RouteResult>("GET", `/api/maps/trips/${id}/route?profile=${profile}`),
  pois: (id: number, category: string) =>
    request<{ category: string; pois: Poi[] }>("GET", `/api/maps/trips/${id}/pois?category=${category}`).then((r) => r.pois),
  addFromSearch: (id: number, b: { name: string; lat: number; lng: number; address?: string | null; day_id?: number }) =>
    request<{ place: Place }>("POST", `/api/maps/trips/${id}/places/from-search`, b).then((r) => r.place),
};

// ---------- journal ----------
export interface Journey {
  id: number;
  title: string;
  description: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  is_public?: number;
  public_token?: string | null;
  photos_count?: number;
  entries_count?: number;
}

export interface JourneyEntry {
  id: number;
  entry_date: string;
  title: string | null;
  body: string | null;
  mood: string | null;
  weather: string | null;
}

export interface JourneyPhoto {
  id: number;
  source: Source;
  r2_key: string | null;
  external_url: string | null;
  thumbnail_url: string | null;
  caption: string | null;
  lat: number | null;
  lng: number | null;
  author: string | null;
}

export interface JourneyCheckin {
  id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  checked_in_at: string;
}

export const journeys = {
  list: () => request<{ journeys: Journey[] }>("GET", "/api/journeys").then((r) => r.journeys),
  create: (b: Record<string, unknown>) =>
    request<{ journey: Journey }>("POST", "/api/journeys", b).then((r) => r.journey),
  detail: (id: number) =>
    request<{
      journey: Journey;
      entries: JourneyEntry[];
      checkins: JourneyCheckin[];
      photos: JourneyPhoto[];
      trip_ids: number[];
    }>("GET", `/api/journeys/${id}`),
  remove: (id: number) => request<{ ok: true }>("DELETE", `/api/journeys/${id}`),
  map: (id: number) => request<{ type: string; features: MapPhotoFeature[] }>("GET", `/api/journeys/${id}/map`),
  addEntry: (id: number, b: Record<string, unknown>) =>
    request<{ entry: JourneyEntry }>("POST", `/api/journeys/${id}/entries`, b).then((r) => r.entry),
  updateEntry: (id: number, entryId: number, b: Record<string, unknown>) =>
    request<{ entry: JourneyEntry }>("PATCH", `/api/journeys/${id}/entries/${entryId}`, b).then((r) => r.entry),
  removeEntry: (id: number, entryId: number) => request<{ ok: true }>("DELETE", `/api/journeys/${id}/entries/${entryId}`),
  addCheckin: (id: number, b: Record<string, unknown>) =>
    request<{ checkin: JourneyCheckin }>("POST", `/api/journeys/${id}/checkins`, b).then((r) => r.checkin),
  removeCheckin: (id: number, checkinId: number) => request<{ ok: true }>("DELETE", `/api/journeys/${id}/checkins/${checkinId}`),
  uploadPhoto: (id: number, form: FormData) =>
    request<{ photo: JourneyPhoto }>("POST", `/api/journeys/${id}/photos`, form).then((r) => r.photo),
  addExternalPhoto: (id: number, b: Record<string, unknown>) =>
    request<{ photo: JourneyPhoto }>("POST", `/api/journeys/${id}/photos/external`, b).then((r) => r.photo),
  updatePhoto: (id: number, photoId: number, b: Record<string, unknown>) =>
    request<{ photo: JourneyPhoto }>("PATCH", `/api/journeys/${id}/photos/${photoId}`, b).then((r) => r.photo),
  removePhoto: (id: number, photoId: number) => request<{ ok: true }>("DELETE", `/api/journeys/${id}/photos/${photoId}`),
  share: (id: number) => request<{ token: string; url: string }>("POST", `/api/journeys/${id}/share`),
  revokeShare: (id: number) => request<{ ok: true }>("DELETE", `/api/journeys/${id}/share`),
};

// ---------- page publique ----------
export const shared = {
  get: (token: string) =>
    request<{
      trip: Pick<Trip, "id" | "title" | "description" | "start_date" | "end_date" | "cover_image">;
      places: Place[];
      photo_shares: PhotoShare[];
      permissions: { share_map: boolean; share_photos: boolean };
    }>("GET", `/api/shared/${token}`),
};

/** URL d'une photo : les chemins /api/... passent par la capability du lien public. */
export function photoUrl(url: string, shareToken?: string): string {
  if (shareToken && url.startsWith("/api/")) return `${url}${url.includes("?") ? "&" : "?"}share=${encodeURIComponent(shareToken)}`;
  return url;
}