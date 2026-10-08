-- Migration 0003 : index membres + recherche lieux.

CREATE INDEX IF NOT EXISTS idx_trip_members_trip ON trip_members(trip_id);
CREATE INDEX IF NOT EXISTS idx_places_trip_category ON places(trip_id, category);
