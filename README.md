# TREK Cloudflare — version Workers

Portage **Cloudflare-native** du self-hosted [TREK](../TREK) (`liketrek/TREK`) :
API **Hono** sur Workers + **D1** (métadonnées), **R2** (photos), **KV** (rate-limit,
cache oEmbed), **Durable Objects** (temps réel par voyage), front React en
**Static Assets**.

## Client web

Le front est **`web/`** — React 19 + Vite + Leaflet, écrit contre cette API.
Le client d'origine `../TREK/client` **n'est pas utilisé** : il appelle ~477 routes
(`admin` ×88, `trips` ×170, `journeys` ×34, `integrations` ×25, `addons` ×19…) alors
que l'API Workers en expose bien moins ; le brancher faisait planter l'app au
chargement (404 dès `/auth/me`, settings, app-config). Il reste dans le dépôt comme
référence. Voir `frontend/README.md`.

## Fonctionnalités

**Voyages** — CRUD, liste paginée (keyset), jours, lieux géolocalisés, import en lot
(`nom | lat | lng | n° de jour`), édition inline, suppression atomique.

**Plan du jour** — `day_assignments` est la **source unique** de vérité du
rattachement d'un lieu à un jour et de son ordre (la colonne `places.day_id` de la
v0.1 a été supprimée en migration 0004 pour éviter une double vérité).
`GET /api/trips/:id/plan` renvoie le plan Jour → lieux ordonnés ; réordonnancement
par `POST /assignments/reorder`.

**Réservations & hébergements** — réservations typées (vol, train, ferry, restaurant,
musée…), statut, confirmation, coût en centimes ; hébergements sur une plage de jours.

**Budget** — montants en **centimes entiers**, catégories, répartition personnalisée
par membre ; les parts doivent se réconcilier avec le total (`shares_must_sum_to_total`).

**Listes** — préparation (catégories, cochage, progression) et to-do (priorité, échéance).

**Journal de voyage** (`journeys`) — récit daté, check-ins, photos géolocalisées
(upload R2, Instagram, WordPress), pins déplaçables sur la carte, partage public.

**Photos partagées sur la carte** — `GET /api/trips/:id/map-photos` (GeoJSON) et
`GET /api/journeys/:id/map` ; couleur par source (upload / Instagram / WordPress).

**Carte & recherche, sans clé** — recherche (Photon + Nominatim, dédupliquée),
géocoding inverse au clic, itinéraire OSRM (voiture/marche/vélo), POI par catégorie
via Overpass avec **miroir automatique** si l'endpoint public est saturé.

**Partage** — lien public par voyage (`share_tokens`, drapeaux carte/photos, expiration,
révocation) et par journal (`journeys.public_token`). Les binaires R2 restent privés :
un lien public n'expose que les photos externes.

**Temps réel** — Durable Object `TripRoom` (hibernation) : une room WebSocket par
voyage, diffusion serveur → clients, anti-écho côté client.

**Offline-first (PWA)** — c'est le cœur de l'original, porté ici :
- `web/public/sw.js` : shell précaché, navigations réseau→cache, assets hachés
  cache→réseau, lectures API mises en cache. Les écritures ne sont **jamais**
  interceptées par le SW (elles passent par la file, sinon la clé d'idempotence
  serait perdue).
- `web/src/offline.ts` : file de mutations en IndexedDB, ordre préservé, rejeu
  automatique au retour du réseau avec la `X-Idempotency-Key` d'origine.
- Bandeau d'état réseau + nombre de modifications en attente.
- Manifest + icônes : l'app est installable (iOS/Android) et démarre hors-ligne.

**Intégrations** — Instagram via oEmbed public (lien public, sans token) et WordPress
via REST `/media` + `/posts` (avec garde SSRF même-hôte).

## Architecture

```
trek-cloudflare/
  src/index.ts            Composition : middlewares, montage des routes, /ws, fallback SPA
  src/routes/             auth, trips, days, places, assignments, planning (reservations,
                          accommodations), tripdata (budget/packing/todos/tags/categories),
                          photos, share, journeys, instagram, wordpress, maps, members,
                          export, weather
  src/realtime/TripRoom.ts Durable Object (hibernation)
  src/lib/                http, validate, contracts, journey, geo, access, cache,
                          ratelimit, notify, idempotency, export
  src/db/client.ts        Helpers D1 + gardes d'accès
  migrations/             0001 core · 0002 idempotence · 0003 index membres ·
                          0004 planification (+ backfill assignations) · 0005 journal
  web/                    Client React (Vite) → build vers ../public
  tests/                  35 tests vitest (contrats, parseurs, curseurs, exports)
  scripts/seed.mjs        Seed démo
```

| Origine (Nest + better-sqlite3) | Cloudflare |
|---|---|
| `server/src/db/*` (WAL, migrations positionnelles) | `migrations/*.sql` D1, `db.prepare().bind()`, `db.batch()` |
| `nest/storage` (local/S3) | R2 (`photos/<trip>/…`, `journeys/<id>/…`) |
| `nest/realtime` (`ws@8`) | Durable Object `TripRoom` + `/ws/trip/:id` |
| `nest/share` (`share_tokens`) | idem en D1 + `GET /api/shared/:token` |
| `nest/auth` (bcrypt) | JWT HS256 WebCrypto + PBKDF2 100k (cap Workers) |
| `nest/maps` (Nominatim/OSRM/Overpass) | `src/lib/geo.ts`, mêmes services sans clé |
| `client/dist` servi par Nest | Workers Static Assets (`./public`, fallback SPA) |

## Démarrage

```bash
cd trek-cloudflare
npm install
cp .dev.vars.example .dev.vars      # JWT_SECRET, WP_SITE_URL…
npx wrangler d1 create trek-db      # IDs déjà renseignés dans wrangler.jsonc
npx wrangler r2 bucket create trek-photos
npx wrangler kv namespace create SESSIONS
npm run db:migrate:local
npm run db:seed:local               # compte démo
npm run dev                         # API + worker sur :8787

npm run frontend:dev                # front sur :5173 (proxy /api)
npm run frontend:build              # web/ → ../public
npm run deploy
```

Secrets prod : `npx wrangler secret put JWT_SECRET`.

## Endpoints

| Méthode | Route | Auth |
|---|---|---|
| POST | `/api/auth/register`, `/login` (rate-limit 10/min/IP) | public |
| GET | `/api/auth/me` | session |
| GET/POST | `/api/trips`, `/api/trips/:id` (GET/PATCH/DELETE) | session / membre / owner |
| GET/POST | `/api/trips/:id/days`, `/api/days/:dayId` | membre |
| GET/POST | `/api/trips/:id/places`, `/places/bulk`, `/api/places/:placeId` | membre |
| GET | `/api/trips/:id/plan` · `/assignments` · POST `/assignments/reorder` | membre (`?share=` pour `plan`) |
| GET/POST/PATCH/DELETE | `/api/trips/:id/reservations`, `/accommodations` | membre |
| GET/POST/PATCH/DELETE | `/api/trips/:id/budget`, `/packing`, `/todos` | membre |
| GET/POST/DELETE | `/api/trips/:id/members`, `/api/tags`, `/api/categories` | membre / owner |
| GET | `/api/trips/:id/map-photos` (GeoJSON) | membre ou `?share=` |
| GET | `/api/trips/:id/export.gpx`, `/calendar.ics`, `/weather` | membre ou `?share=` |
| GET | `/api/shared/:token` (edge-cache 60 s) | public |
| GET/POST/PATCH/DELETE | `/api/journeys…`, `/entries`, `/checkins`, `/photos`, `/map`, `/share` | membre |
| GET | `/api/public/journey/:token` | public |
| GET | `/api/maps/search`, `/reverse`, `/trips/:id/route`, `/trips/:id/pois` | public / membre |
| GET/POST | `/api/photos/instagram/preview` + pin, `/api/photos/wordpress/media|posts` + pin | public/session/membre |
| WS | `/ws/trip/:id` (`?token=` ou `?share=`) | membre |

Mutations rejouables via `X-Idempotency-Key`. La clé est **réservée avant
traitement** (`status = 0`) : deux requêtes identiques simultanées ne peuvent donc
pas appliquer l'effet deux fois — la perdante reçoit `425 Too Early` et le client
réessaie. Une clé terminée rejoue la réponse mémorisée (`x-idempotent-replay`).

## Idempotence : le piège du rejeu concurrent

Écrire la clé **après** traitement ne protège de rien en concurrence : deux
concurrence : deux requêtes identiques lisent toutes deux « clé absente » avant que
la première n'écrive. La file hors-ligne rend ce cas réel (l'événement `online`
peut déclencher deux rejeux). D'où : réservation atomique + verrou d'exclusion
côté client. C'est vérifié par `tests/e2e/offline-queue.mjs`, qui échoue si un
voyage est créé deux fois.

## Sécurité

- Session vérifiée sur chaque route ; `?share=` comme unique voie publique, avec
  contrôle du token (expiration, drapeaux).
- CORS en allowlist, `secureHeaders` sur `/api/*` uniquement (jamais sur le 101 du WS).
- Rate-limit KV (fail-open) sur auth, upload et aperçu Insta.
- Validation zod systématique (`.optional()` + `.nullable()` sur les PATCH) ;
  montants entiers ≥ 0 ; parts de budget réconciliées.
- WordPress : timeout, cap de réponse, garde SSRF même-hôte, auth optionnelle.
- Géo : timeouts, plafonds de taille, bornes validées, User-Agent identification.

## Limites assumées

- Pas de plugins (`child_process`), MCP, OIDC/passkeys/TOTP, admin complet,
  Atlas, Collections, Vacay, budget multi-devises — hors Workers ou hors MVP.
- Le journal public n'expose pas les uploads R2 (seuls les liens externes).
- oEmbed Instagram best-effort (rate-limit Meta possible) ; mode Graph API non câblé.

## Vérifications

```bash
npm run typecheck            # API
npm test                     # 35 tests de contrats
npm run frontend:build       # typecheck + build du front
npx wrangler deploy --dry-run

# E2E navigateur (nécessite E2E_PASSWORD, et playwright chromium)
E2E_PASSWORD='…' node tests/e2e/parcours.mjs       # parcours complet + PWA + hors-ligne
E2E_PASSWORD='…' node tests/e2e/offline-queue.mjs  # file + absence de doublon
```

Les deux e2e sont idempotents : ils nettoient les données qu'ils créent.