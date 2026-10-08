import { useEffect, useRef } from "react";
import { getToken } from "./api";

/**
 * Écoute les changements du voyage via le Durable Object.
 *
 * Le Worker diffuse `{type, tripId, ...}` à tous les clients connectés à la room
 * SAUFS celui qui a émis l'événement (anti-écho, comme le gateway Nest d'origine).
 * Côté client on ne renvoie donc pas nos propres mutations : on recharge quand
 * l'événement vient d'un autre onglet / autre appareil.
 */
export function useTripEvents(tripId: number, onRemoteChange: () => void): void {
  const handler = useRef(onRemoteChange);
  handler.current = onRemoteChange;

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/trip/${tripId}?token=${encodeURIComponent(token)}`);
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as { type?: string; tripId?: number };
        if (msg.tripId !== undefined && msg.tripId !== tripId) return;
        if (typeof msg.type === "string" && msg.type.endsWith(".deleted")) return;
        handler.current();
      } catch {
        /* message non JSON : ignoré */
      }
    };
    ws.onerror = () => {
      /* la reconnexion est gérée par le prochain montage */
    };
    return () => ws.close();
  }, [tripId]);
}