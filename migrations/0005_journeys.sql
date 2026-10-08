-- Migration 0005 — journal de voyage (« journeys »), calqué sur server/src/db/migrations.ts
-- (schema final : ids entiers, journey -> voyages liés par `journey_trips`).

CREATE TABLE IF NOT EXISTS journeys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  cover_r2_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  started_at TEXT,
  ended_at TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  public_token TEXT UNIQUE,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_journeys_user ON journeys(user_id);

-- Un journal peut englober plusieurs voyages.
CREATE TABLE IF NOT EXISTS journey_trips (
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (journey_id, trip_id)
);
CREATE INDEX IF NOT EXISTS idx_journey_trips_journey ON journey_trips(journey_id);

-- Check-ins : les « étapes » visitées (lieu d'un voyage, ou libre).
CREATE TABLE IF NOT EXISTS journey_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  lat REAL,
  lng REAL,
  address TEXT,
  country_code TEXT,
  notes TEXT,
  checked_in_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_checkins_journey ON journey_checkins(journey_id, checked_in_at);

-- Entrées de récit (une par jour, ou plusieurs).
CREATE TABLE IF NOT EXISTS journey_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  checkin_id INTEGER REFERENCES journey_checkins(id) ON DELETE SET NULL,
  entry_date TEXT NOT NULL,
  title TEXT,
  body TEXT,
  mood TEXT,
  weather TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_journey ON journey_entries(journey_id, entry_date);

-- Photos du journal : upload R2 (`r2_key`) OU référence externe Insta/WordPress
-- (`source = 'instagram' | 'wordpress'` + url), unification avec photo_shares.
CREATE TABLE IF NOT EXISTS journey_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  entry_id INTEGER REFERENCES journey_entries(id) ON DELETE CASCADE,
  checkin_id INTEGER REFERENCES journey_checkins(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'upload',
  r2_key TEXT,
  external_url TEXT,
  thumbnail_url TEXT,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  caption TEXT,
  taken_at TEXT,
  lat REAL,
  lng REAL,
  author TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_jphotos_journey ON journey_photos(journey_id);
CREATE INDEX IF NOT EXISTS idx_jphotos_entry ON journey_photos(entry_id);
CREATE INDEX IF NOT EXISTS idx_jphotos_geo ON journey_photos(journey_id, lat, lng);

CREATE TABLE IF NOT EXISTS journey_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer',
  UNIQUE(journey_id, user_id)
);