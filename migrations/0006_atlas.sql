-- Migration 0006 : l'atlas — les pays visités, leurs photos, leurs bonnes adresses.
--
-- Choix structurant : la page d'accueil de Trippy n'est pas une liste de voyages
-- mais la carte du monde. Cette migration crée donc un modèle PAR PAYS, distinct
-- du modèle PAR VOYAGE qui existe déjà (`trips`/`days`/`places`).
--
-- Pourquoi deux modèles ? Un voyage est daté et linéaire : trois jours en Islande.
-- Un pays est un lieu de mémoire : on y revient, on y mange bien, on y a des
-- photos de 2019 et de 2025. Les rattacher par `trip_id` serait une erreur de
-- modèle — un pays n'appartient à aucun voyage. Donc aucun `trip_id` ici, et
-- aucune cascade depuis `trips` : la suppression d'un voyage ne doit pas faire
-- disparaître des pays visités.
--
-- `iso_n3` est un ENTIER : c'est le code ISO 3166-1 numérique, c'est-à-dire
-- exactement l'identifiant utilisé par les contours du monde (Natural Earth via
-- `world-atlas`). Stocker ce code permet de relier une ligne SQL à un `<path>`
-- de la carte sans table de correspondance. Entre 001 et 894, 3 chiffres.

-- ---------------------------------------------------------------- pays visités
CREATE TABLE IF NOT EXISTS countries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- ISO 3166-1 numérique. Contrainte applicative : 1..894.
  iso_n3 INTEGER NOT NULL,

  -- Première et dernière visite, en 'YYYY-MM-DD'. `visits` compte les allers-
  ---retours : un pays y retourné trois fois mérite une encre plus dense sur la
  -- carte que celui où l'on n'est passé qu'une fois.
  visited_from TEXT,
  visited_to TEXT,
  visits INTEGER NOT NULL DEFAULT 1,

  -- Ce que je retiens du pays, en une ligne. `note` apparaît dans la table des
  -- matières ; `story` est le récit, sur la page du pays.
  note TEXT,
  story TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Un pays ne peut existir qu'une fois par compte : c'est la contrainte qui
  -- permet à la carte de colorier un contour sans compter les doublons.
  UNIQUE(user_id, iso_n3)
);

CREATE INDEX IF NOT EXISTS idx_countries_user ON countries(user_id);
-- La table des matières est triée par date de dernière visite : la plus récente
-- en haut, comme un carnet qu'on rouvre au dernier paragraphe écrit.
CREATE INDEX IF NOT EXISTS idx_countries_recent ON countries(user_id, visited_to, visited_from);

-- ------------------------------------------------------------- photos de pays
CREATE TABLE IF NOT EXISTS country_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,

  -- Polymorphe, comme `journey_photos` : `r2_key` XOR `external_url`.
  r2_key TEXT,
  external_url TEXT,

  caption TEXT,
  taken_on TEXT,
  lat REAL,
  lng REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_country_photos_country ON country_photos(country_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_country_photos_geo ON country_photos(country_id, lat, lng);

-- ------------------------------------------------------------ bonnes adresses
CREATE TABLE IF NOT EXISTS spots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_id INTEGER NOT NULL REFERENCES countries(id) ON DELETE CASCADE,

  name TEXT NOT NULL,

  -- Domaine fermé, contrôlé par `spotKinds` dans src/lib/atlas.ts. Pas de CHECK
  -- dans le schéma : la convention du projet est de valider en Zod.
  kind TEXT NOT NULL DEFAULT 'other',

  city TEXT,

  -- `verdict` est la partie qui fait la valeur de l'entrée : ce qu'on en pense,
  -- en une phrase, dans la langue du voyageur. Pas de note chiffrée à la place —
  -- un coup de cœur ne se met pas sur une échelle.
  verdict TEXT,

  -- Trésorerie en centimes, aligné sur le reste du schéma (budget, réservations).
  price_cents INTEGER,

  url TEXT,
  lat REAL,
  lng REAL,
  visited_on TEXT,
  notes TEXT,

  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_spots_country ON spots(country_id, kind);
CREATE INDEX IF NOT EXISTS idx_spots_geo ON spots(country_id, lat, lng);
CREATE INDEX IF NOT EXISTS idx_spots_order ON spots(country_id, sort_order);
