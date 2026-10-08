-- Migration 0002 : idempotence + index carte.
-- ALTER TABLE ADD COLUMN : D1/SQLite OK (colonne NULL pour les lignes existantes).

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_user ON idempotency_keys(user_id);

-- Lien photo uploadée <-> photo_shares (suppression en cascade applicative).
ALTER TABLE photo_shares ADD COLUMN photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_photoshares_photo ON photo_shares(photo_id);

-- Filtre carte par source + lookup géo des lieux.
CREATE INDEX IF NOT EXISTS idx_photoshares_trip_source ON photo_shares(trip_id, source);
CREATE INDEX IF NOT EXISTS idx_places_trip_geo ON places(trip_id, lat, lng);
