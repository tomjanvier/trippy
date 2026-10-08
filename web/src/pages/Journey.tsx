import { useCallback, useEffect, useState } from "react";
import { journeys, photoUrl, type MapPhotoFeature } from "../api";
import { navigate } from "../App";
import { TripMap } from "../components/TripMap";

export function Journeys() {
  const [list, setList] = useState<{ id: number; title: string; description: string | null; started_at: string | null; photos_count?: number; entries_count?: number }[]>([]);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await journeys.list());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "chargement impossible");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="stack">
      <form
        className="card row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          setBusy(true);
          setErr(null);
          void journeys
            .create({ title: title.trim(), started_at: date || null })
            .then((j) => navigate(`/journey/${j.id}`))
            .catch((e2: Error) => {
              setErr(e2.message);
              setBusy(false);
            });
          e.preventDefault();
        }}
      >
        <input style={{ flex: 1, minWidth: 200 }} placeholder="Nouveau journal…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input style={{ width: 170 }} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button type="submit" disabled={busy}>
          {busy ? "…" : "Créer"}
        </button>
      </form>
      {err && <div className="error">{err}</div>}
      <div className="list">
        {list.map((j) => (
          <div className="list-item" key={j.id}>
            <div>
              <strong>{j.title}</strong>
              <div className="muted">
                {j.started_at ?? "sans date"} · {j.entries_count ?? 0} entrée(s) · {j.photos_count ?? 0} photo(s)
              </div>
            </div>
            <button onClick={() => navigate(`/journey/${j.id}`)}>Ouvrir</button>
          </div>
        ))}
        {list.length === 0 && <div className="muted">Aucun journal. Crée le premier ci-dessus.</div>}
      </div>
    </div>
  );
}

export function JourneyDetail({ id }: { id: number }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof journeys.detail>> | null>(null);
  const [features, setFeatures] = useState<MapPhotoFeature[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [entryDate, setEntryDate] = useState("");
  const [entryTitle, setEntryTitle] = useState("");
  const [entryBody, setEntryBody] = useState("");
  const [igUrl, setIgUrl] = useState("");
  const [igLat, setIgLat] = useState("");
  const [igLng, setIgLng] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await journeys.detail(id));
      const m = await journeys.map(id);
      setFeatures(m.features);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "chargement impossible");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const say = (m: string) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 2500);
  };

  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="muted">Chargement…</div>;

  return (
    <div className="stack">
      <div className="row">
        <button className="ghost" onClick={() => navigate("/")}>
          ← Journaux
        </button>
        <h2 style={{ flex: 1 }}>{data.journey.title}</h2>
        <button
          onClick={() => {
            if (!confirm(`Supprimer « ${data.journey.title} » ?`)) return;
            void journeys.remove(id).then(() => navigate("/"));
          }}
        >
          Supprimer
        </button>
      </div>
      {flash && <div className="muted">{flash}</div>}
      {data.journey.description && <div className="muted">{data.journey.description}</div>}

      {features.length > 0 && (
        <TripMap
          features={features}
          photoHref={(f) => f.properties.url}
          onPhotoMoved={(f, lat, lng) => {
            void journeys
              .updatePhoto(id, f.properties.id, { lat, lng })
              .then(() => {
                say("Photo déplacée.");
                void load();
              })
              .catch((e: Error) => say(`Erreur : ${e.message}`));
          }}
        />
      )}

      <div className="grid two">
        <div className="card stack">
          <h3>Entrées</h3>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (!entryDate) return;
              void journeys
                .addEntry(id, { entry_date: entryDate, title: entryTitle || null, body: entryBody || null })
                .then(() => {
                  setEntryTitle("");
                  setEntryBody("");
                  void load();
                })
                .catch((e2: Error) => say(`Erreur : ${e2.message}`));
              e.preventDefault();
            }}
          >
            <div className="row">
              <input style={{ width: 160 }} type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
              <input style={{ flex: 1 }} placeholder="Titre" value={entryTitle} onChange={(e) => setEntryTitle(e.target.value)} />
            </div>
            <textarea rows={3} placeholder="Récit…" value={entryBody} onChange={(e) => setEntryBody(e.target.value)} />
            <button type="submit">Ajouter l'entrée</button>
          </form>
          <div className="divider" />
          <div className="list">
            {data.entries.map((en) => (
              <div className="list-item" key={en.id} style={{ flexDirection: "column", alignItems: "stretch" }}>
                <div className="row">
                  <strong>{en.entry_date}</strong>
                  {en.title && <span>{en.title}</span>}
                  {en.mood && <span className="pill">{en.mood}</span>}
                  <span style={{ flex: 1 }} />
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm("Supprimer cette entrée ?")) void journeys.removeEntry(id, en.id).then(() => void load());
                    }}
                  >
                    ✕
                  </button>
                </div>
                {en.body && <div className="muted">{en.body.slice(0, 240)}</div>}
              </div>
            ))}
            {data.entries.length === 0 && <div className="muted">Aucune entrée.</div>}
          </div>
        </div>

        <div className="card stack">
          <h3>Photos géolocalisées</h3>
          <div className="thumbs">
            {data.photos.map((p) => (
              <div className="thumb" key={p.id} title={p.caption ?? ""}>
                <img
                  src={photoUrl(p.thumbnail_url ?? p.external_url ?? `/api/journeys/${id}/photos/${p.id}/file`)}
                  alt={p.caption ?? ""}
                  loading="lazy"
                />
                <button
                  className="x"
                  onClick={() => {
                    if (confirm("Supprimer cette photo ?")) void journeys.removePhoto(id, p.id).then(() => void load());
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            {data.photos.length === 0 && <div className="muted">Aucune photo.</div>}
          </div>

          <div className="divider" />

          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (!igUrl.trim()) return;
              void journeys
                .addExternalPhoto(id, {
                  source: "instagram",
                  external_url: igUrl.trim(),
                  lat: igLat ? Number(igLat) : null,
                  lng: igLng ? Number(igLng) : null,
                })
                .then(() => {
                  say("Photo Instagram ajoutée.");
                  setIgUrl("");
                  void load();
                })
                .catch((e2: Error) => say(`Erreur : ${e2.message}`));
              e.preventDefault();
            }}
          >
            <h3 style={{ margin: 0 }}>Depuis Instagram</h3>
            <input placeholder="https://www.instagram.com/p/…" value={igUrl} onChange={(e) => setIgUrl(e.target.value)} />
            <div className="row">
              <input style={{ flex: 1 }} placeholder="lat" value={igLat} onChange={(e) => setIgLat(e.target.value)} />
              <input style={{ flex: 1 }} placeholder="lng" value={igLng} onChange={(e) => setIgLng(e.target.value)} />
              <button type="submit">Ajouter</button>
            </div>
          </form>

          <div className="divider" />

          <div className="stack">
            <h3 style={{ margin: 0 }}>Upload</h3>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const fd = new FormData();
                fd.append("file", f);
                const first = data.photos.find((p) => p.lat !== null);
                if (first?.lat != null && first?.lng != null) {
                  fd.append("lat", String(first.lat));
                  fd.append("lng", String(first.lng));
                }
                void journeys
                  .uploadPhoto(id, fd)
                  .then(() => {
                    say("Photo uploadée.");
                    void load();
                  })
                  .catch((e2: Error) => say(`Erreur : ${e2.message}`));
                e.target.value = "";
              }}
            />
          </div>
        </div>
      </div>

      {data.checkins.length > 0 && (
        <div className="card stack">
          <h3>Check-ins</h3>
          <div className="list">
            {data.checkins.map((ck) => (
              <div className="list-item" key={ck.id}>
                <div>
                  <strong>{ck.name}</strong>
                  <div className="muted">
                    {String(ck.checked_in_at).slice(0, 10)}
                    {ck.lat !== null ? ` · ${ck.lat.toFixed(3)}, ${ck.lng?.toFixed(3)}` : ""}
                  </div>
                </div>
                <button className="danger" onClick={() => void journeys.removeCheckin(id, ck.id).then(() => void load())}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}