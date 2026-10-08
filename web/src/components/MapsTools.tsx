import { useState } from "react";
import { maps, type Poi, type RouteResult, type SearchResult } from "../api";

const POI_CATEGORIES = ["restaurant", "cafe", "bar", "hotel", "museum", "viewpoint", "park", "beach", "shop", "pharmacy", "bank", "fuel"];

const fmtKm = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
const fmtDur = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** Recherche de lieux (Photon + Nominatim) et ajout au voyage. */
export function PlaceSearch({ tripId, days, onAdded }: { tripId: number; days: { id: number; day_number: number }[]; onAdded: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dayId, setDayId] = useState("");

  return (
    <div className="card stack">
      <h3>Rechercher un lieu</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length < 2) return;
          setBusy(true);
          setErr(null);
          maps
            .search(q.trim())
            .then(setResults)
            .catch((e2: Error) => {
              setErr(e2.message);
              setResults([]);
            })
            .finally(() => setBusy(false));
          e.preventDefault();
        }}
      >
        <input style={{ flex: 1 }} placeholder="Geysir, Reykjavik, Colosseo…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select style={{ width: 120 }} value={dayId} onChange={(e) => setDayId(e.target.value)}>
          <option value="">— jour —</option>
          {days.map((d) => (
            <option key={d.id} value={d.id}>
              J{d.day_number}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          {busy ? "…" : "Chercher"}
        </button>
      </form>
      {err && <div className="error">{err}</div>}
      <div className="list" style={{ maxHeight: 260, overflowY: "auto" }}>
        {results.map((r) => (
          <div className="list-item" key={`${r.osm_id}-${r.lat}-${r.lng}`}>
            <div>
              <strong>{r.name}</strong>
              <div className="muted">{r.address ?? `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}`}</div>
            </div>
            <button
              onClick={() => {
                void maps
                  .addFromSearch(tripId, {
                    name: r.name,
                    lat: r.lat,
                    lng: r.lng,
                    address: r.address ?? null,
                    ...(dayId ? { day_id: Number(dayId) } : {}),
                  })
                  .then(() => {
                    setResults([]);
                    setQ("");
                    onAdded();
                  })
                  .catch((e2: Error) => setErr(e2.message));
              }}
            >
              Ajouter
            </button>
          </div>
        ))}
        {results.length === 0 && <div className="muted">Aucun résultat.</div>}
      </div>
      <div className="muted">OpenStreetMap, sans clé.</div>
    </div>
  );
}

/** Itinéraire entre les lieux du voyage (OSRM) + POI par catégorie (Overpass). */
export function RouteAndPois({ tripId, onAddPoi }: { tripId: number; onAddPoi: () => void }) {
  const [profile, setProfile] = useState<"driving" | "walking" | "cycling">("driving");
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routeErr, setRouteErr] = useState<string | null>(null);
  const [category, setCategory] = useState("restaurant");
  const [pois, setPois] = useState<Poi[] | null>(null);
  const [poiErr, setPoiErr] = useState<string | null>(null);

  return (
    <div className="grid two">
      <div className="card stack">
        <h3>Itinéraire</h3>
        <div className="row">
          <select style={{ width: 140 }} value={profile} onChange={(e) => setProfile(e.target.value as typeof profile)}>
            <option value="driving">Voiture</option>
            <option value="walking">Marche</option>
            <option value="cycling">Vélo</option>
          </select>
          <button
            onClick={() => {
              setRouteErr(null);
              maps
                .route(tripId, profile)
                .then(setRoute)
                .catch((e: Error) => {
                  setRoute(null);
                  setRouteErr(e.message);
                });
            }}
          >
            Calculer
          </button>
        </div>
        {route && (
          <div className="muted">
            {route.stops} étapes · {fmtKm(route.distanceM)} · {fmtDur(route.durationS)}
          </div>
        )}
        {routeErr && <div className="error">{routeErr}</div>}
        <div className="muted">OSRM, sans clé.</div>
      </div>

      <div className="card stack">
        <h3>POI à proximité</h3>
        <div className="row">
          <select style={{ flex: 1 }} value={category} onChange={(e) => setCategory(e.target.value)}>
            {POI_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              setPoiErr(null);
              maps
                .pois(tripId, category)
                .then((r) => setPois(r))
                .catch((e: Error) => {
                  setPois(null);
                  setPoiErr(e.message);
                });
            }}
          >
            Chercher
          </button>
        </div>
        {poiErr && <div className="error">Overpass indisponible ({poiErr})</div>}
        <div className="list" style={{ maxHeight: 240, overflowY: "auto" }}>
          {(pois ?? []).map((p) => (
            <div className="list-item" key={p.osm_id}>
              <div>
                <strong>{p.name ?? "(sans nom)"}</strong>
                <div className="muted">
                  {[p.tags.cuisine, p.tags.opening_hours].filter(Boolean).join(" · ") || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`}
                </div>
              </div>
              <button
                onClick={() => {
                  void maps
                    .addFromSearch(tripId, { name: p.name ?? p.osm_id, lat: p.lat, lng: p.lng })
                    .then(() => onAddPoi())
                    .catch(() => onAddPoi());
                }}
              >
                Ajouter
              </button>
            </div>
          ))}
          {pois && pois.length === 0 && <div className="muted">Aucun POI trouvé.</div>}
        </div>
        <div className="muted">Overpass (OpenStreetMap), miroir automatique si saturé.</div>
      </div>
    </div>
  );
}