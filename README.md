# Trippy

Un carnet de voyage personnel, autohébergé sur Cloudflare Workers. La page
d'accueil n'est pas une liste de voyages : c'est **la carte du monde**, avec les
pays visités coloriés à l'encre et un fil qui les relie dans l'ordre des visites.

Chaque pays a sa page : ce qu'on y retient en une ligne, le récit, les photos en
planche-contact, et **les bonnes adresses** — le resto où tu reviendrais, le café
où tu t'asseoirais une heure entière, l'hôtel où tu ne réfléchirais pas.

Trippy est un **fork modifié de [TREK](https://github.com/liketrek/TREK)**
(licence AGPL-3.0), porté sur l'infrastructure Cloudflare. Voir
[`MODIFIED.md`](MODIFIED.md) pour le détail du portage et des corrections, et
[`NOTICE.md`](NOTICE.md) pour les attributions tierces.

> **Si tu clones ce dépôt :** tu le fais sous AGPL-3.0. Le §13 oblige quiconque
> interagit avec le programme par le réseau à proposer le code source
> correspondant ; c'est pourquoi le lien du dépôt est dans le pied de page de
> l'application. Le `TRADEMARKS.md` de TREK interdit à un fork divergent de
> reprendre le nom ou les logos d'origine : Trippy porte donc son propre nom et
> son propre emblème.

---

## Ce que ça fait

**L'atlas** — la carte du monde en SVG, dessinée à partir des frontières Natural
Earth, projetée en Natural Earth 1 (la projection des atlas scolaires, qui ne
gonfle pas le Groenland). Les pays visités sont pleins ; l'intensité de l'encre
encode le nombre d'allers-retours ; un **fil de voyage** relie les pays du plus
ancien au plus récent par grands cercles, découpé sur la sphère. Chaque pays est
cliquable, au clavier comme à la souris.

**La table des matières** — la même information dans l'autre sens : celle du nom,
que la carte ne sait pas donner. Une ligne par pays, drapeau, années, ce que tu
en retiens. Les pays déjà vus dans tes journaux mais absents de la carte sont
proposés en un clic.

**La page d'un pays** — le récit, puis les photos, puis les bonnes adresses groupées
par catégorie (manger, boire, dormir, voir, marcher, acheter) dans l'ordre dans
lequel on cherche une adresse. Le champ `verdict` est la donnée : une phrase
qu'on aura plaisir à relire dans deux ans.

**Le reste de TREK** — voyages, plan par jour, lieux géolocalisés, budget en
centimes, check-lists, réservations, hébergements, journaux, photos partagées sur
la carte (upload R2, Instagram, WordPress), recherche et itinéraire sans clé
(Photon, Nominatim, OSRM, Overpass), temps réel, partage par lien, hors-ligne.

## Démarrer en local

Il faut Node 20+ et un compte Cloudflare gratuit.

```bash
npm install
npm --prefix web install

cp .dev.vars.example .dev.vars
# JWT_SECRET : openssl rand -hex 32

npm run db:migrate:local     # crée le schéma D1
npm run db:seed:local        # compte de démo + 9 pays d'exemple

npm run dev                  # Worker sur :8787
npm run frontend:dev         # Vite sur :5173, proxifie /api et /ws
```

Le compte de démo est `demo` / `trippy-demo-123` (ou `SEED_PASSWORD=…`).

Pour que les données de démo ne restent pas : les pays sont dans `countries`,
leurs adresses dans `spots` et leurs photos dans `country_photos`.

Mot de passe oublié ? Le hachage est PBKDF2 salé, donc il n'est pas récupérable —
mais il se remet, directement sur D1, sans passer par l'API :

```bash
PASSWORD='…' node scripts/reset-password.mjs --email demo@trippy.local --remote
# sans PASSWORD : le script en génère un et l'affiche
```

## Déployer

Les ressources existent déjà (D1 `trek-db`, R2 `trek-photos`, KV `SESSIONS`).
Pour repartir de zéro :

```bash
npx wrangler d1 create trek-db        # puis recopier l'id dans wrangler.jsonc
npx wrangler r2 bucket create trek-photos
npx wrangler kv namespace create SESSIONS
npx wrangler d1 migrations apply trek-db --remote
npm run frontend:build                # web/ vers ./public — OBLIGATOIRE avant deploy
npx wrangler secret put JWT_SECRET
npm run deploy
```

> `frontend:build` vide `./public` puis y écrit le build. Déployer sans avoir
> construit envoie l'application précédente. L'ordre est donc toujours
> `frontend:build && deploy`.

## Vérifications

```bash
npm run typecheck        # le Worker (tsconfig.json) puis les tests (tsconfig.tests.json)
npm test                 # 52 tests de contrats, dont 17 sur l'atlas
npm run frontend:build   # typecheck + build du client
npx wrangler deploy --dry-run
```

Les tests sont des tests de **contrats** : ils vérifient les règles des schémas
Zod et les fonctions pures, pas des requêtes HTTP. `tests/atlas.test.ts` couvre
notamment le refus d'un code ISO en alpha-2 (qui ferait disparaître un pays de la
carte sans message), la cohérence de la fenêtre de visite, et l'ordre du fil.
`tests/project-identity.test.ts` compare les constantes de `src/lib/project.ts` et
`web/src/identity.ts`, qui sont dupliquées pour une raison d'arbres de
compilation et ne doivent jamais diverger.

E2E navigateur (nécessite `E2E_PASSWORD` et le chromium de Playwright) :

```bash
E2E_PASSWORD='…' npm run test:e2e
```

## Architecture

```
src/index.ts        composition : middlewares, montage des routes, /ws, repli SPA
src/routes/         auth · trips · days · places · assignments · planning ·
                    tripdata · photos · share · journeys · atlas · maps · export
src/lib/            http · validate · contracts · journey · atlas · geo · access ·
                    cache · ratelimit · notify · idempotency · export · project
src/realtime/       TripRoom (Durable Object, hibernation)
migrations/         0001 core · 0002 idempotence · 0003 index · 0004 planification ·
                    0005 journaux · 0006 atlas
web/                client React 19 + Vite → build vers ../public
tests/              52 tests vitest
scripts/            seed.mjs · build-country-data.mjs · fetch-fonts.mjs ·
                    reset-password.mjs · apply-fork-transform.py
```

| Origine (TREK : Nest + better-sqlite3) | Trippy (Workers) |
|---|---|
| `server/src/db/*` (WAL, migrations positionnelles) | `migrations/*.sql` D1, `db.prepare().bind()`, `db.batch()` |
| `nest/storage` (local / S3) | R2 (`photos/<tripId>/…`, `atlas/countries/<id>/…`) |
| `nest/realtime` (`ws@8`) | Durable Object `TripRoom` + `/ws/trip/:id` |
| `nest/auth` (bcrypt) | JWT HS256 WebCrypto + PBKDF2 100k |
| `client/dist` servi par Nest | Workers Static Assets (`./public`, repli SPA) |

### Pourquoi deux modèles : le voyage et le pays

L'explication est dans l'en-tête de `migrations/0006_atlas.sql`, et c'est le point
de conception le plus important du projet. Un **voyage** est daté et linéaire :
trois jours en Islande. Un **pays** est un lieu de mémoire : on y revient, on y
mange bien, on y a des photos de 2019 et de 2025. Les rattacher par `trip_id`
serait une erreur de modèle — un pays n'appartient à aucun voyage. Donc
`countries` n'a **aucun** `trip_id`, et supprimer un voyage ne fait pas
disparaître des pays visités.

L'identifiant du pays est le **code ISO 3166-1 numérique** (`iso_n3`), parce que
c'est exactement l'identifiant des polygones Natural Earth : pas de table de
correspondance entre la base et la carte. `web/src/data/countries.json` apporte le
nom français et le drapeau, et est **généré** par
`node scripts/build-country-data.mjs` puis commité — `Intl.DisplayNames` ne sait
pas traduire un code numérique, et sa sortie dépend de la version d'ICU du
runtime.

### Régénérer les données

```bash
node scripts/build-country-data.mjs   # web/src/data/countries.json (250 pays)
node scripts/fetch-fonts.mjs          # WOFF2 + web/src/fonts.css
python3 scripts/apply-fork-transform.py --check   # 0 = fork à jour
node scripts/reset-password.mjs --email <adresse> [--remote]
```

## Limites assumées

- **L'atlas n'a pas de lien public.** Le partage par lien existe pour les
  voyages, pas pour l'atlas : c'est une vue personnelle. Les photos d'un pays
  passent par la session, jamais par un jeton.
- **Pas de temps réel sur l'atlas.** Une room `TripRoom` est attachée à un voyage ;
  l'atlas n'en a pas. Il se relit au chargement, et la file hors ligne rejoue les
  écritures comme le reste.
- **Natural Earth en 1:110m.** 105 Ko plutôt que 739 Ko en 1:50m, et l'écart ne
  porte que sur les micro-États. Un pays enregistré sans contour à cette échelle
  est marqué « hors carte » dans la table des matières plutôt que de disparaître
  sans explication.
- **Pas de plugins, MCP, OIDC, admin, Atlas ni budget multi-devises** — hors MVP
  Workers ou hors périmètre.
- **Les données de démo sont inventées.** `scripts/seed.mjs` crée 9 pays et 12
  adresses fictives pour que la carte ait quelque chose à montrer.
