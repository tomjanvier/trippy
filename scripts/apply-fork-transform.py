#!/usr/bin/env python3
"""Rejoue les transformations de renommage et les corrections de dérive de Trippy.

Idempotent : chaque règle ne s'applique que si son motif est présent, donc le
script peut être relancé sans effet de bord. Sert aussi de garde : si une
transformation est déjà passée mais que le motif réapparaît (par exemple après
un `rsync` depuis l'amont), le script la réapplique.

Usage : python3 scripts/apply-fork-transform.py [--check]
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# (fichier, avant, après) — remplacements littéraux, appliqués si `avant` existe.
SUBS: list[tuple[str, str, str]] = [
    # ---- Marque : nom de projet (le TRADEMARKS.md amont impose un nom propre) ----
    ("src/lib/export.ts", "trek-cloudflare", "trippy"),
    ("tests/export.test.ts", "trek-cloudflare", "trippy"),
    ("src/index.ts", 'service: "trek-cloudflare"', 'service: "trippy"'),
    ("src/lib/cache.ts", "x-trek-cache", "x-trippy-cache"),
    ("src/routes/photos.ts", "x-trek-cache", "x-trippy-cache"),
    ("src/auth.ts", "trek_session", "trippy_session"),
    ("src/routes/auth.ts", "trek_session", "trippy_session"),
    ("src/lib/geo.ts", 'const UA = "trek-cloudflare/0.3 (self-hosted travel planner)";', "const UA = USER_AGENT;"),
    ("src/photos/instagram.ts", '"user-agent": "trek-cloudflare/0.1 (+map-share)"', '"user-agent": USER_AGENT'),
    ("src/photos/wordpress.ts", '"user-agent": "trek-cloudflare/0.1 (+wordpress-sync)"', '"user-agent": USER_AGENT'),
    ("src/routes/weather.ts", '"user-agent": "trek-cloudflare/0.2 (+weather)"', '"user-agent": USER_AGENT'),
    ("wrangler.jsonc", '"name": "trek-cloudflare"', '"name": "trippy"'),
    ("wrangler.jsonc", "https://trek-cloudflare.tckgrg9ytv.workers.dev", "https://trippy.tckgrg9ytv.workers.dev"),
    ("package.json", '"name": "trek-cloudflare"', '"name": "trippy"'),
    ("package.json", '"version": "0.2.0"', '"version": "1.0.0"'),
    ("web/package.json", '"name": "trek-cloudflare-web"', '"name": "trippy-web"'),
    ("tests/e2e/parcours.mjs", "https://trek-cloudflare.tckgrg9ytv.workers.dev", "https://trippy.tckgrg9ytv.workers.dev"),
    ("tests/e2e/offline-queue.mjs", "https://trek-cloudflare.tckgrg9ytv.workers.dev", "https://trippy.tckgrg9ytv.workers.dev"),
    # ---- Stockage côté client ----
    ("web/src/api.ts", 'const TOKEN_KEY = "trek_token"', 'const TOKEN_KEY = "trippy_token"'),
    ("web/src/offline.ts", 'const DB_NAME = "trek-offline"', 'const DB_NAME = "trippy-offline"'),
    ("web/src/offline.ts", 'localStorage.getItem("trek_token")', 'localStorage.getItem("trippy_token")'),
    ("web/src/offline.ts", "trek:replayed", "trippy:replayed"),
    ("web/src/pages/Trips.tsx", "trek:replayed", "trippy:replayed"),
    # ---- Wordmark dans l'interface ----
    ("web/index.html", 'content="TREK"', 'content="Trippy"'),
    ("web/index.html", "<title>TREK — voyages & photos</title>", "<title>Trippy — carnets & adresses</title>"),
    ("web/src/App.tsx", "<h1>TREK</h1>", "<h1>Trippy</h1>"),
    ("web/src/pages/Login.tsx", "<h2>TREK</h2>", "<h2>Trippy</h2>"),
    ("web/src/pages/SharedTrip.tsx", "<h1>TREK — partage</h1>", "<h1>Trippy — partage</h1>"),
]

# Imports à ajouter s'ils manquent : (fichier, ligne d'ancrage, import à insérer après).
IMPORTS: list[tuple[str, str, str]] = [
    ("src/lib/geo.ts", 'import type { Env } from "../env";', 'import { USER_AGENT } from "./project";'),
    ("src/photos/instagram.ts", 'import type { Env } from "../env";', 'import { USER_AGENT } from "../lib/project";'),
    ("src/photos/wordpress.ts", 'import type { Env } from "../env";', 'import { USER_AGENT } from "../lib/project";'),
    ("src/routes/weather.ts", 'import { err } from "../lib/http";', 'import { USER_AGENT } from "../lib/project";'),
]

# Blocs entiers à remplacer (corrections de dérive, voir MODIFIED.md).
BLOCKS: list[tuple[str, str, str]] = [
    (
        "src/db/client.ts",
        "export interface PlaceRow {\n  id: number;\n  trip_id: number;\n  day_id: number | null;\n  name: string;",
        "export interface PlaceRow {\n  id: number;\n  trip_id: number;\n  name: string;",
    ),
    (
        "web/src/api.ts",
        "export interface Place {\n  id: number;\n  trip_id: number;\n  day_id: number | null;\n  name: string;",
        "export interface Place {\n  id: number;\n  trip_id: number;\n  name: string;",
    ),
    (
        "src/routes/export.ts",
        "    `SELECT d.day_number, d.date, d.title, p.name AS place_name\n"
        "     FROM days d LEFT JOIN places p ON p.day_id = d.id\n"
        "     WHERE d.trip_id = ? ORDER BY d.day_number, p.id`,",
        "    // Le rattachement jour ↔ lieu vit dans `day_assignments` (source unique de\n"
        "    // vérité depuis la migration 0004) ; `places.day_id` n'existe plus. L'ordre\n"
        "    // du plan est `order_index`, pas `p.id`.\n"
        "    `SELECT d.day_number, d.date, d.title, p.name AS place_name\n"
        "     FROM days d\n"
        "     LEFT JOIN day_assignments a ON a.day_id = d.id\n"
        "     LEFT JOIN places p ON p.id = a.place_id\n"
        "     WHERE d.trip_id = ? ORDER BY d.day_number, a.order_index`,",
    ),
    (
        "src/routes/places.ts",
        '  if (!sets.length) return err(c, "bad_request", 400);\n'
        '  sets.push("updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')");\n'
        "  await c.env.DB.prepare(`UPDATE places SET ${sets.join(\", \")} WHERE id = ?`).bind(...binds, placeId).run();\n"
        "  // Rattachement de jour : null = retirer le lieu de tous les jours.\n"
        "  if (b.day_id !== undefined) {",
        "  const reassignsDay = b.day_id !== undefined;\n"
        "  // `day_id` est un champ virtuel : il agit sur `day_assignments`, pas sur la\n"
        "  // ligne `places`. Un PATCH qui ne déplace que le lieu est donc valide même\n"
        "  // sans aucun champ scalaire — tester `sets` seul le rendait impossible.\n"
        '  if (!sets.length && !reassignsDay) return err(c, "bad_request", 400);\n'
        "  if (sets.length) {\n"
        '    sets.push("updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')");\n'
        "    await c.env.DB.prepare(`UPDATE places SET ${sets.join(\", \")} WHERE id = ?`).bind(...binds, placeId).run();\n"
        "  }\n"
        "  // Rattachement de jour : null = retirer le lieu de tous les jours.\n"
        "  if (reassignsDay) {",
    ),
    (
        "src/routes/places.ts",
        "  }\n  if (!sets.length) return err(c, \"bad_request\", 400);\n"
        '  sets.push("updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')");\n'
        "  await c.env.DB.prepare(`UPDATE places SET ${sets.join(\", \")} WHERE id = ?`).bind(...binds, placeId).run();\n"
        "  const place = await getPlace(c.env.DB, placeId);",
        "  }\n  const place = await getPlace(c.env.DB, placeId);",
    ),
    (
        "src/routes/days.ts",
        "  // FK : places.day_id passe à NULL automatiquement.",
        "  // Le rattachement jour ↔ lieu est porté par `day_assignments`, dont les lignes\n"
        "  // partent en cascade avec le jour (`ON DELETE CASCADE`). La colonne\n"
        "  // `places.day_id` a été supprimée en migration 0004 et n'est plus à=nullée.",
    ),
    (
        "scripts/seed.mjs",
        "INSERT OR IGNORE INTO places (id, trip_id, day_id, name, lat, lng, address) VALUES\n"
        "  (1, 1, 2, 'Geysir', 64.3105, -20.3029, 'Geysir, Islande'),\n"
        "  (2, 1, 3, 'Seljalandsfoss', 63.6156, -19.9886, 'Seljalandsfoss, Islande');",
        "INSERT OR IGNORE INTO places (id, trip_id, name, lat, lng, address) VALUES\n"
        "  (1, 1, 'Geysir', 64.3105, -20.3029, 'Geysir, Islande'),\n"
        "  (2, 1, 'Seljalandsfoss', 63.6156, -19.9886, 'Seljalandsfoss, Islande');\n"
        "-- Le rattachement jour ↔ lieu vit dans day_assignments depuis la migration 0004\n"
        "-- (places.day_id n'existe plus). order_index suit l'ordre du plan.\n"
        "INSERT OR IGNORE INTO day_assignments (day_id, place_id, order_index) VALUES (2, 1, 0), (3, 2, 0);",
    ),
    (
        "scripts/seed.mjs",
        "-- Seed trek-cloudflare (généré, rejouable : INSERT OR IGNORE)\n"
        "INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (1, 'demo', 'demo@trek.local'",
        "-- Seed trippy (généré, rejouable : INSERT OR IGNORE)\n"
        "INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (1, 'demo', 'demo@trippy.local'",
    ),
    (
        "scripts/seed.mjs",
        'console.log("Compte démo : demo / demo@trek.local");',
        'console.log("Compte démo : demo / demo@trippy.local");',
    ),
    (
        "scripts/seed.mjs",
        'mkdtempSync(join(tmpdir(), "trek-seed-"))',
        'mkdtempSync(join(tmpdir(), "trippy-seed-"))',
    ),
    (
        "web/src/api.ts",
        '  remove: (placeId: number) => request<{ ok: true }>("DELETE", `/api/places/${placeId}`),\n};',
        '  remove: (placeId: number) => request<{ ok: true }>("DELETE", `/api/places/${placeId}`),\n'
        "  /**\n"
        "   * Rattachement jour ↔ lieu. `places.day_id` a été supprimé du schéma en\n"
        "   * migration 0004 : la seule source de vérité est `day_assignments`, exposé\n"
        "   * par /plan. Seul un lieu retenu à un jour apparaît ici.\n"
        "   */\n"
        "  dayOf: async (tripId: number): Promise<Map<number, number>> => {\n"
        "    const plan = await trips.plan(tripId);\n"
        "    const m = new Map<number, number>();\n"
        "    for (const d of plan.days) for (const it of d.items) if (!m.has(it.place_id)) m.set(it.place_id, d.id);\n"
        "    return m;\n"
        "  },\n"
        "};",
    ),
    (
        "web/src/pages/TripDetail.tsx",
        '  const [draftName, setDraftName] = useState("");',
        '  const [draftName, setDraftName] = useState("");\n'
        "  /** placeId → dayId, reconstruit depuis /plan (le schéma n'a plus places.day_id). */\n"
        "  const [dayOf, setDayOf] = useState<Map<number, number>>(() => new Map());",
    ),
    (
        "web/src/pages/TripDetail.tsx",
        "      setFeatures((await trips.mapPhotos(id)).features);",
        "      setFeatures((await trips.mapPhotos(id)).features);\n"
        "      places.dayOf(id).then(setDayOf).catch(() => setDayOf(new Map()));",
    ),
    (
        "web/src/pages/TripDetail.tsx",
        "<PlacesCard tripId={id} places={list} days={days} onChanged={load} onFlash={flash} />",
        "<PlacesCard tripId={id} places={list} days={days} dayOf={dayOf} onChanged={load} onFlash={flash} />",
    ),
    (
        "web/src/pages/TripDetail.tsx",
        "function PlacesCard({\n  tripId,\n  places: list,\n  days,\n  onChanged,\n  onFlash,\n}: {\n  tripId: number;\n  places: Place[];\n  days: Day[];",
        "function PlacesCard({\n  tripId,\n  places: list,\n  days,\n  dayOf,\n  onChanged,\n  onFlash,\n}: {\n  tripId: number;\n  places: Place[];\n  days: Day[];\n  dayOf: Map<number, number>;",
    ),
    (
        "web/src/pages/TripDetail.tsx",
        "function PlaceRow({\n  place: p,\n  days,\n  onChanged,\n  onFlash,\n}: {\n  place: Place;\n  days: Day[];",
        "function PlaceRow({\n  place: p,\n  days,\n  dayOf,\n  onChanged,\n  onFlash,\n}: {\n  place: Place;\n  days: Day[];\n  dayOf: Map<number, number>;",
    ),
    (
        "web/src/pages/TripDetail.tsx",
        'const [dayId, setDayId] = useState(p.day_id?.toString() ?? "");',
        'const [dayId, setDayId] = useState(dayOf.get(p.id)?.toString() ?? "");',
    ),
    (
        "web/src/pages/TripDetail.tsx",
        "{days.find((d) => d.id === p.day_id) ? ` · J${days.find((d) => d.id === p.day_id)!.day_number}` : \"\"}",
        "{days.find((d) => d.id === dayOf.get(p.id)) ? ` · J${days.find((d) => d.id === dayOf.get(p.id))!.day_number}` : \"\"}",
    ),
    (
        "web/src/pages/TripDetail.tsx",
        "<PlaceRow key={p.id} place={p} days={days} onChanged={onChanged} onFlash={onFlash} />",
        "<PlaceRow key={p.id} place={p} days={days} dayOf={dayOf} onChanged={onChanged} onFlash={onFlash} />",
    ),
]


def main() -> int:
    check_only = "--check" in sys.argv
    applied = 0
    pending: list[str] = []

    for rel, old, new in SUBS:
        p = ROOT / rel
        if not p.exists():
            pending.append(f"{rel}: fichier absent")
            continue
        s = p.read_text()
        # `new` est testé en premier : certaines substitutions contiennent
        # elles-mêmes `old` (ajout de lignes), donc `old in s` reste vrai après
        # application et ne prouve rien.
        if new in s:
            continue
        if old in s:
            if not check_only:
                p.write_text(s.replace(old, new))
            applied += 1
        else:
            pending.append(f"{rel}: ni motif « {old[:60]} » ni remplacement déjà posés")

    for rel, anchor, imp in IMPORTS:
        p = ROOT / rel
        if not p.exists():
            pending.append(f"{rel}: fichier absent")
            continue
        s = p.read_text()
        if imp in s:
            continue
        if anchor not in s:
            pending.append(f"{rel}: ancre d'import introuvable « {anchor} »")
            continue
        if not check_only:
            p.write_text(s.replace(anchor, f"{anchor}\n{imp}", 1))
        applied += 1

    for rel, old, new in BLOCKS:
        p = ROOT / rel
        if not p.exists():
            pending.append(f"{rel}: fichier absent")
            continue
        s = p.read_text()
        if new in s:
            continue
        if old in s:
            if not check_only:
                p.write_text(s.replace(old, new, 1))
            applied += 1
        else:
            head = old.splitlines()[0][:60] if old else ""
            pending.append(f"{rel}: ni bloc d'origine ni bloc remplacement trouvés — « {head} »")

    print(f"{applied} transformation(s) {'appliquées' if not check_only else 'à appliquer'}.")
    for w in pending:
        print(f"  ATTENTION {w}")
    return 1 if pending else 0


if __name__ == "__main__":
    raise SystemExit(main())
