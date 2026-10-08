import { useEffect, useState } from "react";
import { photoUrl, shared, type PhotoShare, type Place } from "../api";
import { TripMap } from "../components/TripMap";

interface Payload {
  trip: { id: number; title: string; description: string | null; start_date: string | null; end_date: string | null; cover_image: string | null };
  places: Place[];
  photo_shares: PhotoShare[];
  permissions: { share_map: boolean; share_photos: boolean };
}

/** Page publique /shared/:token — lecture seule, aucun compte requis. */
export function SharedTrip({ token }: { token: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    shared
      .get(token)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message === "not_found" ? "Ce lien de partage n'existe plus (révoqué ?)." : e.message);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  if (err) {
    return (
      <main>
        <div className="card stack">
          <h2>Lien indisponible</h2>
          <div className="error">{err}</div>
          <a href="/">Aller à l'application</a>
        </div>
      </main>
    );
  }
  if (!data) return <main className="muted">Chargement…</main>;

  const geo = data.photo_shares.filter((s) => s.lat !== null && s.lng !== null);
  const features = geo.map((s, i) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [s.lng!, s.lat!] as [number, number] },
    properties: {
      id: s.id ?? i,
      source: s.source,
      url: photoUrl(s.thumbnail_url ?? s.url, token),
      thumbnail: photoUrl(s.thumbnail_url ?? s.url, token),
      caption: s.caption,
      author: s.author,
      place_id: s.place_id,
    },
  }));

  return (
    <div className="app">
      <header className="topbar">
        <h1>TREK — partage</h1>
        <span className="spacer" />
        <span className="muted">lecture seule</span>
      </header>
      <main className="stack">
        <div className="card stack">
          <h2>{data.trip.title}</h2>
          {data.trip.description && <div className="muted">{data.trip.description}</div>}
          {data.trip.start_date && (
            <div className="muted">
              {data.trip.start_date} → {data.trip.end_date ?? "…"}
            </div>
          )}
        </div>

        {data.places.length > 0 && <TripMap places={data.places} features={features} photoHref={(f) => f.properties.url} />}

        {geo.length > 0 && (
          <div className="card stack">
            <h3>Photos</h3>
            <div className="thumbs">
              {geo.map((s) => (
                <a className="thumb" key={s.id} href={photoUrl(s.url, token)} target="_blank" rel="noreferrer" title={s.caption ?? ""}>
                  <img src={photoUrl(s.thumbnail_url ?? s.url, token)} alt={s.caption ?? ""} loading="lazy" />
                </a>
              ))}
            </div>
          </div>
        )}

        {data.places.length > 0 && (
          <div className="card stack">
            <h3>Lieux</h3>
            <div className="list">
              {data.places.map((p) => (
                <div className="list-item" key={p.id}>
                  <div>
                    <strong>{p.name}</strong>
                    {p.address && <div className="muted">{p.address}</div>}
                  </div>
                  {p.lat !== null && p.lng !== null && (
                    <span className="muted">
                      {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {data.places.length === 0 && geo.length === 0 && <div className="muted">Rien à afficher pour ce partage.</div>}
      </main>
    </div>
  );
}