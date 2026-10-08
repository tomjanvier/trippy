import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./env";
import { extractToken, optionalAuth, verifySession } from "./auth";
import { assertTripAccess, getShareByToken } from "./db/client";
import { err } from "./lib/http";
import { idempotency } from "./lib/idempotency";
import authRoutes from "./routes/auth";
import daysRoutes from "./routes/days";
import { exportNested } from "./routes/export";
import { instagramApi, instagramNested } from "./routes/instagram";
import journeysApi from "./routes/journeys";
import { membersNested } from "./routes/members";
import mapsApi from "./routes/maps";
import { assignmentsNested } from "./routes/assignments";
import { accommodationsNested, reservationsNested } from "./routes/planning";
import { photosNested } from "./routes/photos";
import { placesApi, placesNested } from "./routes/places";
import sharedRoutes from "./routes/share";
import { budgetNested, categoriesApi, packingNested, placeTagsNested, tagsApi, todoNested } from "./routes/tripdata";
import tripsRoutes from "./routes/trips";
import { weatherNested } from "./routes/weather";
import { wordpressApi, wordpressNested } from "./routes/wordpress";

// Durable Object déclaré dans wrangler.jsonc (TRIP_ROOM).
export { TripRoom } from "./realtime/TripRoom";

const app = new Hono<{ Bindings: Env }>();

// Middlewares limités à /api/* : la poignée de main WebSocket (/ws/*)
// retourne une réponse 101 aux headers immuables — aucun middleware
// global ne doit tenter de la réécrire.
app.use("/api/*", secureHeaders());
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      const allowed = [c.env.APP_URL, "http://localhost:5173", "http://localhost:8787", "http://localhost:3000"].filter(
        (o): o is string => !!o,
      );
      if (origin && allowed.includes(origin)) return origin;
      // Origine non listée : renvoie une origine qui ne matchera pas -> navigateur bloque.
      return allowed[0] ?? "";
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Idempotency-Key", "X-Socket-Id"],
    maxAge: 86400,
  }),
);
app.use("/api/*", optionalAuth);
app.use("/api/*", idempotency);

app.get("/api/health", (c) => c.json({ ok: true, service: "trek-cloudflare", time: new Date().toISOString() }));

app.route("/api/auth", authRoutes);
app.route("/api/trips", tripsRoutes);
app.route("/api/trips", placesNested);
app.route("/api/trips", photosNested);
app.route("/api/trips", instagramNested);
app.route("/api/trips", wordpressNested);
app.route("/api/trips", membersNested);
app.route("/api/trips", exportNested);
app.route("/api/trips", weatherNested);
app.route("/api/trips", assignmentsNested);
app.route("/api/trips", reservationsNested);
app.route("/api/trips", accommodationsNested);
app.route("/api/trips", budgetNested);
app.route("/api/trips", packingNested);
app.route("/api/trips", todoNested);
app.route("/api/trips", placeTagsNested);
app.route("/api/tags", tagsApi);
app.route("/api/categories", categoriesApi);
app.route("/api", journeysApi);
app.route("/api/maps", mapsApi);
app.route("/api/days", daysRoutes);
app.route("/api/places", placesApi);
app.route("/api/shared", sharedRoutes);
app.route("/api/photos/instagram", instagramApi);
app.route("/api/photos/wordpress", wordpressApi);

// ---------- Realtime : WebSocket par voyage, avec auth réelle ----------
// ?share=<token> (public) ou JWT via ?token= / cookie / Bearer.
app.get("/ws/trip/:id", async (c) => {
  const tripId = Number(c.req.param("id"));
  if (!Number.isFinite(tripId)) return err(c, "not_found", 404);
  const share = c.req.query("share");
  if (share) {
    const row = await getShareByToken(c.env.DB, share);
    if (!row || row.trip_id !== tripId) return err(c, "unauthorized", 401);
  } else {
    const token = c.req.query("token") ?? extractToken(c);
    const user = token && c.env.JWT_SECRET ? await verifySession(c.env.JWT_SECRET, token) : null;
    if (!user || !(await assertTripAccess(c.env.DB, tripId, user.id))) {
      return err(c, "unauthorized", 401);
    }
  }
  const stub = c.env.TRIP_ROOM.get(c.env.TRIP_ROOM.idFromName(`trip-${tripId}`));
  return stub.fetch(c.req.raw);
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/ws/")) return err(c, "not_found", 404);
  // Workers Static Assets : fallback SPA (index.html) configuré dans wrangler.jsonc.
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
