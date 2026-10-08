import type { DurableObjectState } from "@cloudflare/workers-types";

/**
 * Room WebSocket par voyage (remplace le gateway ws Nest d'origine).
 *
 * Mode hibernation : aucune socket n'est conservée en mémoire JavaScript —
 * `state.getWebSockets()` survit aux évictions de l'objet, et les messages
 * sont relayés via `webSocketMessage`. Le client s'identifie avec son
 * `socketId` (protocole d'origine) pour l'anti-écho.
 */
export class TripRoom {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    // Notification serveur -> broadcast (notifyTrip via POST interne).
    if (request.method === "POST") {
      const text = await request.text().catch(() => "");
      if (text) this.broadcast(text);
      return Response.json({ ok: true });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 65536) return;
    // Valide que c'est du JSON avant de relayer (évite le spam binaire).
    try {
      JSON.parse(message);
    } catch {
      return;
    }
    for (const sock of this.state.getWebSockets()) {
      if (sock !== ws && sock.readyState === WebSocket.OPEN) {
        try {
          sock.send(message);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async webSocketClose(): Promise<void> {
    // Rien à nettoyer : l'hibernation gère le cycle de vie.
  }

  async webSocketError(): Promise<void> {
    // Idem.
  }

  private broadcast(text: string): void {
    for (const sock of this.state.getWebSockets()) {
      if (sock.readyState === WebSocket.OPEN) {
        try {
          sock.send(text);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
