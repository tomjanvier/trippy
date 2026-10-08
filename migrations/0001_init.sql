-- TREK Cloudflare — schéma D1 (MVP).
-- Dérivé de server/src/db/schema.ts (better-sqlite3) porté en D1 async.
-- Volontairement réduit : coeur trips/days/places/photos/share + photo_shares (insta/wp).
-- Les modules avancés (plugins, MCP, vacay, collections, budget détaillé...) restent
-- dans la version self-hosted d'origine et pourront être ajoutés par migrations suivantes.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  avatar TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  start_date TEXT,
  end_date TEXT,
  currency TEXT DEFAULT 'EUR',
  cover_image TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);

CREATE TABLE IF NOT EXISTS days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_number INTEGER NOT NULL,
  date TEXT,
  notes TEXT,
  title TEXT,
  UNIQUE(trip_id, day_number)
);
CREATE INDEX IF NOT EXISTS idx_days_trip ON days(trip_id);

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_id INTEGER REFERENCES days(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  lat REAL,
  lng REAL,
  address TEXT,
  category TEXT,
  notes TEXT,
  image_url TEXT,
  website TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_places_trip ON places(trip_id);
CREATE INDEX IF NOT EXISTS idx_places_day ON places(day_id);
CREATE INDEX IF NOT EXISTS idx_places_latlng ON places(lat, lng);

-- Photos uploadées vers R2 (métadonnées en D1, binaire en R2 sous photos/<tripId>/<key>)
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
  day_id INTEGER REFERENCES days(id) ON DELETE SET NULL,
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  caption TEXT,
  lat REAL,
  lng REAL,
  taken_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_trip ON photos(trip_id);
CREATE INDEX IF NOT EXISTS idx_photos_place ON photos(place_id);

-- Liens de partage public (équivalent share_tokens de l'origine, simplifié)
CREATE TABLE IF NOT EXISTS share_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  share_map INTEGER NOT NULL DEFAULT 1,
  share_photos INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(trip_id)
);
CREATE INDEX IF NOT EXISTS idx_share_token ON share_tokens(token);

CREATE TABLE IF NOT EXISTS trip_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(trip_id, user_id)
);

-- Photos externes épinglées sur la carte d'un voyage :
-- source = 'instagram' | 'wordpress' | 'upload'
-- Pour instagram en mode embed : url = lien public du post, oembed_json = réponse oEmbed mise en cache.
-- Pour wordpress : url = URL du média, wp_post_id / wp_media_id pour resync via REST API.
CREATE TABLE IF NOT EXISTS photo_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'upload',
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  caption TEXT,
  lat REAL,
  lng REAL,
  taken_at TEXT,
  author TEXT,
  oembed_json TEXT,
  wp_post_id INTEGER,
  wp_media_id INTEGER,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_photoshares_trip ON photo_shares(trip_id);
CREATE INDEX IF NOT EXISTS idx_photoshares_source ON photo_shares(source);
