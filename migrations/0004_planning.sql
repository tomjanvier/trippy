-- Migration 0004 — domaine « planification » (portage de server/src/db/schema.ts + migrations).
--
-- Choix structurant : `day_assignments` devient la SOURCE UNIQUE de vérité
-- pour « quel(s) jour(s) un lieu appartient, et dans quel ordre ».
-- La colonne `places.day_id` de la v0.1 est reprise puis supprimée : garder les
-- deux créerait une double vérité qui diverge dès le premier drag&drop.

-- ---------- catégories & tags ----------
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  icon TEXT DEFAULT '📍',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#10b981',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- lieux <-> jours (source unique) ----------
CREATE TABLE IF NOT EXISTS day_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(day_id, place_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_day ON day_assignments(day_id, order_index);
CREATE INDEX IF NOT EXISTS idx_assignments_place ON day_assignments(place_id);

CREATE TABLE IF NOT EXISTS place_tags (
  place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (place_id, tag_id)
);

-- Reprise des lieux déjà rattachés à un jour par places.day_id, puis retrait de
-- la colonne (ALTER TABLE DROP COLUMN est supporté par SQLite >= 3.35 / D1).
-- ROW_NUMBER (window function, supportée par SQLite 3.25+ / D1) : donne un ordre
-- stable et dense par jour, là où une sous-requête MAX() verrait toutes les
-- lignes à order_index = 0 pendant la même instruction.
INSERT OR IGNORE INTO day_assignments (day_id, place_id, order_index)
  SELECT day_id, id, rn - 1 FROM (
    SELECT day_id, id, ROW_NUMBER() OVER (PARTITION BY day_id ORDER BY id) AS rn
    FROM places
    WHERE day_id IS NOT NULL
  );

-- L'index de la v0.1 porte sur places.day_id : il doit disparaître avec la colonne.
DROP INDEX IF EXISTS idx_places_day;

ALTER TABLE places DROP COLUMN day_id;

-- ---------- réservations ----------
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_id INTEGER REFERENCES days(id) ON DELETE SET NULL,
  end_day_id INTEGER REFERENCES days(id) ON DELETE SET NULL,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
  assignment_id INTEGER REFERENCES day_assignments(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'pending',
  reservation_time TEXT,
  reservation_end_time TEXT,
  location TEXT,
  confirmation_number TEXT,
  notes TEXT,
  travelers TEXT,
  provider TEXT,
  url TEXT,
  cost_cents INTEGER,
  currency TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reservations_trip ON reservations(trip_id);
CREATE INDEX IF NOT EXISTS idx_reservations_day ON reservations(day_id);

-- ---------- hébergements (séjour sur une plage de jours) ----------
CREATE TABLE IF NOT EXISTS day_accommodations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
  start_day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  end_day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
  check_in TEXT,
  check_in_end TEXT,
  check_out TEXT,
  confirmation TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_accommodations_trip ON day_accommodations(trip_id);

-- ---------- budget (montants en centimes entiers, cf. Money) ----------
CREATE TABLE IF NOT EXISTS budget_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'Other',
  name TEXT NOT NULL,
  total_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  persons INTEGER,
  days INTEGER,
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_budget_trip ON budget_items(trip_id, sort_order);

CREATE TABLE IF NOT EXISTS budget_item_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  budget_item_id INTEGER NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE(budget_item_id, user_id)
);

-- ---------- listes de preparation ----------
CREATE TABLE IF NOT EXISTS packing_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_packing_trip ON packing_items(trip_id, sort_order);

-- ---------- to-do ----------
CREATE TABLE IF NOT EXISTS todo_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  description TEXT,
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_todo_trip ON todo_items(trip_id, sort_order);

CREATE TABLE IF NOT EXISTS todo_category_assignees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  category_name TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(trip_id, category_name, user_id)
);