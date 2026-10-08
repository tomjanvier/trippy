import type { D1Database } from "@cloudflare/workers-types";
import { assertTripAccess, getDay, getPlace, getTrip, type TripRow } from "../db/client";
import type { AppContext } from "./http";

/** Résout le voyage parent d'un jour (avec contrôle d'accès). */
export async function tripFromDay(
  db: D1Database,
  dayId: number,
  userId: number | null,
): Promise<{ trip: TripRow; dayId: number } | null> {
  const day = await getDay(db, dayId);
  if (!day) return null;
  const trip = await assertTripAccess(db, day.trip_id, userId);
  if (!trip) return null;
  return { trip, dayId: day.id };
}

/** Résout le voyage parent d'un lieu (avec contrôle d'accès). */
export async function tripFromPlace(
  db: D1Database,
  placeId: number,
  userId: number | null,
): Promise<{ trip: TripRow; placeId: number } | null> {
  const place = await getPlace(db, placeId);
  if (!place) return null;
  const trip = await assertTripAccess(db, place.trip_id, userId);
  if (!trip) return null;
  return { trip, placeId: place.id };
}

export function userIdOf(c: AppContext): number | null {
  return c.get("user")?.id ?? null;
}

export { getTrip };
