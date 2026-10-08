import type { D1Database } from "@cloudflare/workers-types";

export interface TripRow {
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
}

export interface PlaceRow {
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
  created_at: string;
  updated_at: string;
}

export interface PhotoShareRow {
  id: number;
  trip_id: number;
  place_id: number | null;
  source: "instagram" | "wordpress" | "upload";
  url: string;
  thumbnail_url: string | null;
  caption: string | null;
  lat: number | null;
  lng: number | null;
  taken_at: string | null;
  author: string | null;
  oembed_json: string | null;
  wp_post_id: number | null;
  wp_media_id: number | null;
  created_at: string;
}

export async function getTrip(db: D1Database, tripId: number): Promise<TripRow | null> {
  return db.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first<TripRow>();
}

export async function assertTripAccess(
  db: D1Database,
  tripId: number,
  userId: number | null,
): Promise<TripRow | null> {
  const trip = await getTrip(db, tripId);
  if (!trip) return null;
  if (userId !== null && (trip.user_id === userId)) return trip;
  if (userId !== null) {
    const member = await db
      .prepare("SELECT 1 AS ok FROM trip_members WHERE trip_id = ? AND user_id = ?")
      .bind(tripId, userId)
      .first<{ ok: number }>();
    if (member) return trip;
  }
  return null;
}

export interface DayRow {
  id: number;
  trip_id: number;
  day_number: number;
  date: string | null;
  notes: string | null;
  title: string | null;
}

export interface ShareRow {
  id: number;
  trip_id: number;
  token: string;
  share_map: number;
  share_photos: number;
  expires_at: string | null;
  created_at: string;
}

export interface PhotoRow {
  id: number;
  trip_id: number;
  place_id: number | null;
  day_id: number | null;
  r2_key: string;
  original_name: string;
  file_size: number | null;
  mime_type: string | null;
  caption: string | null;
  lat: number | null;
  lng: number | null;
  taken_at: string | null;
  created_at: string;
}
export function nowIso(): string {
  return new Date().toISOString();
}

export async function getDay(db: D1Database, dayId: number): Promise<DayRow | null> {
  return db.prepare("SELECT * FROM days WHERE id = ?").bind(dayId).first<DayRow>();
}

export async function getPlace(db: D1Database, placeId: number): Promise<PlaceRow | null> {
  return db.prepare("SELECT * FROM places WHERE id = ?").bind(placeId).first<PlaceRow>();
}

export async function getPhoto(db: D1Database, tripId: number, photoId: number): Promise<PhotoRow | null> {
  return db
    .prepare("SELECT * FROM photos WHERE id = ? AND trip_id = ?")
    .bind(photoId, tripId)
    .first<PhotoRow>();
}

export async function getShareByToken(db: D1Database, token: string): Promise<ShareRow | null> {
  const row = await db.prepare("SELECT * FROM share_tokens WHERE token = ?").bind(token).first<ShareRow>();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export async function getShareByTrip(db: D1Database, tripId: number): Promise<ShareRow | null> {
  const row = await db.prepare("SELECT * FROM share_tokens WHERE trip_id = ?").bind(tripId).first<ShareRow>();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export function newShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  // base64url sans padding
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
