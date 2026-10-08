import type { AppContext } from "./http";

/** Broadcast best-effort vers la room du voyage, sans bloquer la réponse API. */
export function notifyTrip(c: AppContext, tripId: number, payload: unknown): void {
  try {
    const stub = c.env.TRIP_ROOM.get(c.env.TRIP_ROOM.idFromName(`trip-${tripId}`));
    const req = new Request("https://do/notify", { method: "POST", body: JSON.stringify(payload) });
    c.executionCtx.waitUntil(
      stub
        .fetch(req)
        .then((r) => r.arrayBuffer())
        .catch(() => null),
    );
  } catch {
    /* best effort */
  }
}
