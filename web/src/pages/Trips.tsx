import { useCallback, useEffect, useState } from "react";
import { trips, type Trip, type User } from "../api";
import { navigate } from "../App";

export function Trips({ user: _user }: { user: User }) {
  const [items, setItems] = useState<Trip[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [days, setDays] = useState("3");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (c?: string) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await trips.list(c);
      setItems((prev) => (c ? [...prev, ...r.trips] : r.trips));
      setCursor(r.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "chargement impossible");
    } finally {
      setLoading(false);
    }
  }, []);

  // Chargement initial + rejeu des mutations hors-ligne.
  useEffect(() => {
    void load();
    const onReplayed = () => void load();
    window.addEventListener("trek:replayed", onReplayed);
    return () => window.removeEventListener("trek:replayed", onReplayed);
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const t = await trips.create({ title: title.trim(), days_count: Number(days) || 0 });
      navigate(`/trips/${t.id}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "création impossible");
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <form className="card row" onSubmit={create}>
        <input
          style={{ flex: 1, minWidth: 220 }}
          placeholder="Nouveau voyage…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div style={{ width: 130 }}>
          <label htmlFor="d">Jours</label>
          <input id="d" type="number" min={0} max={60} value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "…" : "Créer"}
        </button>
        <button type="button" className="ghost" onClick={() => void load()}>
          Rafraîchir
        </button>
      </form>

      {err && <div className="error">{err}</div>}

      <div className="list">
        {items.map((t) => (
          <div className="list-item" key={t.id}>
            <div>
              <strong>{t.title}</strong>
              <div className="muted">
                {t.start_date ? `${t.start_date} → ${t.end_date ?? "…"}` : "sans dates"} ·{" "}
                {t.places_count ?? 0} lieu(x) · {t.photos_count ?? 0} photo(s)
              </div>
            </div>
            <button onClick={() => navigate(`/trips/${t.id}`)}>Ouvrir</button>
          </div>
        ))}
        {!loading && items.length === 0 && <div className="muted">Aucun voyage. Crée le premier ci-dessus.</div>}
      </div>

      {loading && <div className="muted">Chargement…</div>}
      {cursor && (
        <div className="row end">
          <button className="ghost" onClick={() => void load(cursor)}>
            Charger plus
          </button>
        </div>
      )}
    </div>
  );
}