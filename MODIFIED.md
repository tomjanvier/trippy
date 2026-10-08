# Modifications apportées à TREK

Trippy est un fork modifié de [TREK](https://github.com/liketrek/TREK)
(v4.3.3), distribué sous **AGPL-3.0** comme l'original. Cette page satisfait les
exigences de l'AGPL-3.0 §5(a) et §5(b) : elle annonce les modifications et la
date, et précise la licence applicable.

- **Écrit le 8 octobre 2026.**
- **Auteur des modifications :** <https://github.com/tomjanvier>

## Nom et marques

L'amont exige qu'un fork divergent porte un nom propre et ne réutilise aucune de
ses marques (voir `TRADEMARKS.md` de TREK). Trippy ren donc le projet partout :
nom du Worker, nom de paquet, titre de l'application, manifest PWA, nom du
cookie de session, clés de stockage local, noms de cache du service worker,
`User-Agent` des appels sortants et champ `service` de `/api/health`. Le logotype
et les icônes amont ne sont pas repris.

## Portage

L'amont est un monorepo npm (NestJS + better-sqlite3 + PostgreSQL…) à déployer
via Docker ou Unraid. Trippy est un **portage Cloudflare-native** : une seule
Worker Hono, sans serveur Node.

| amont (Nest + better-sqlite3) | Trippy (Workers) |
|---|---|
| `server/src/db/*` (WAL, migrations positionnelles) | `migrations/*.sql` D1, `db.prepare().bind()`, `db.batch()` |
| `nest/storage` (local / S3) | R2 (`photos/<tripId>/…`) |
| `nest/realtime` (`ws@8`) | Durable Object `TripRoom` + `/ws/trip/:id` |
| `nest/auth` (bcrypt) | JWT HS256 WebCrypto + PBKDF2 100k |
| `nest/maps` (Nominatim / OSRM / Overpass) | `src/lib/geo.ts`, mêmes services sans clé |
| `client/dist` servi par Nest | Workers Static Assets (`./public`, repli SPA) |

Le client amont (`client/`) appelle ~477 routes contre bien moins dans l'API
Workers ; il n'a pas été branché. Le front de Trippy est un client React neuf
(`web/`), écrit contre l'API existante.

## Corrections apportées au portage

- `calendar.ics` interrogeait `places.day_id`, colonne supprimée par la migration
  0004 : l'export plantait sur « no such column ». Le joint se fait désormais par
  `day_assignments`, et suit `order_index` au lieu de `p.id`.
- `PATCH /api/places/:id` exécutait son `UPDATE` deux fois, et rejetait en `400`
  un PATCH ne déplaçant que le rattachement de jour (le seul champ que la colonne
  supprimée portait). Le test « aucun champ scalaire » ne compte plus
  `day_id`.
- `scripts/seed.mjs` insérait encore `places.day_id` : il aligne sur
  `day_assignments`.
- Types `Place.day_id` retirés des deux côtés (Worker et client), la donnée
  n'existant plus.
- `MAP_DEFAULT_STYLE` était déclaré dans l'environnement et jamais lu.
- `routes/maps.ts` : le type structurel du helper `upstream` était plus étroit
  que `AppContext`.

## Fonctionnalités ajoutées

- **Atlas** (`/atlas`) : la page d'accueil n'est plus une liste de voyages mais
  la carte du monde, les pays visités colorés, un fil reliant les pays dans
  l'ordre des visites, les photos en planche-contact et les bonnes adresses.
  Détails dans le `README.md`.
