import { useEffect, useState } from "react";
import {
  trips,
  type Plan,
  type PlanDay,
  type PlanItem,
  type Place,
} from "../api";

/** Plan du voyage : jours + lieux ordonnés, réordonnable au clavier/boutons. */
export function DayPlan({ tripId, onFlash }: { tripId: number; onFlash: (m: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [addTo, setAddTo] = useState<number | null>(null);

  const load = async () => {
    try {
      setPlan(await trips.plan(tripId));
    } catch (e) {
      onFlash(`Erreur : ${e instanceof Error ? e.message : "plan indisponible"}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  if (!plan) return <div className="muted">Chargement du plan…</div>;

  const move = async (day: PlanDay, from: number, to: number) => {
    const ids = day.items.map((i) => i.place_id);
    const [moved] = ids.splice(from, 1);
    if (moved === undefined) return;
    ids.splice(to, 0, moved);
    // Mise à jour optimiste, revert si l'API refuse.
    setPlan({ ...plan, days: plan.days.map((d) => (d.id === day.id ? { ...d, items: reorderItems(d.items, ids) } : d)) });
    try {
      await trips.reorderDay(tripId, day.id, ids);
    } catch (e) {
      onFlash(`Erreur : ${e instanceof Error ? e.message : "réordonnancement refusé"}`);
      void load();
    }
  };

  const assign = async (place: Place, dayId: number) => {
    try {
      await trips.assign(tripId, { day_id: dayId, place_id: place.id });
      setAddTo(null);
      onFlash(`${place.name} ajouté à ${dayId === plan.days[0]?.id ? "J1" : ""}`);
      void load();
    } catch (e) {
      onFlash(`Erreur : ${e instanceof Error ? e.message : "ajout refusé"}`);
    }
  };

  const unassign = async (item: PlanItem) => {
    try {
      await trips.unassign(tripId, item.assignment_id);
      void load();
    } catch (e) {
      onFlash(`Erreur : ${e instanceof Error ? e.message : "retrait refusé"}`);
    }
  };

  return (
    <div className="card stack">
      <h3>Plan du voyage</h3>
      <div className="grid two">
        {plan.days.map((d) => (
          <div className="stack" key={d.id}>
            <div className="row">
              <strong>J{d.day_number}</strong>
              {d.title && <span className="muted">{d.title}</span>}
              {d.date && <span className="muted">{d.date}</span>}
              <span className="spacer" style={{ flex: 1 }} />
              <button className="ghost" onClick={() => setAddTo(addTo === d.id ? null : d.id)}>
                + lieu
              </button>
            </div>
            <div className="list">
              {d.items.map((it, i) => (
                <div className="list-item" key={it.assignment_id}>
                  <div>
                    <strong>{it.name}</strong>
                    {it.lat !== null && <div className="muted">{it.lat.toFixed(3)}, {it.lng?.toFixed(3)}</div>}
                  </div>
                  <div className="row">
                    <button
                      className="ghost"
                      disabled={i === 0}
                      onClick={() => void move(d, i, i - 1)}
                      title="Monter"
                    >
                      ↑
                    </button>
                    <button
                      className="ghost"
                      disabled={i === d.items.length - 1}
                      onClick={() => void move(d, i, i + 1)}
                      title="Descendre"
                    >
                      ↓
                    </button>
                    <button className="danger" onClick={() => void unassign(it)} title="Retirer du jour">
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              {d.items.length === 0 && <div className="muted">Aucun lieu ce jour-là.</div>}
            </div>
            {addTo === d.id && (
              <PlacePicker
                places={plan.unassigned}
                onPick={(p) => void assign(p, d.id)}
                onClose={() => setAddTo(null)}
              />
            )}
          </div>
        ))}
      </div>
      {plan.unassigned.length > 0 && (
        <div className="muted">{plan.unassigned.length} lieu(x) non rattaché(s) à un jour.</div>
      )}
    </div>
  );
}

function reorderItems(items: PlanItem[], ids: number[]): PlanItem[] {
  const byId = new Map(items.map((i) => [i.place_id, i]));
  return ids
    .map((id) => byId.get(id))
    .filter((x): x is PlanItem => !!x)
    .map((x, i) => ({ ...x, order_index: i }));
}

function PlacePicker({ places, onPick, onClose }: { places: Place[]; onPick: (p: Place) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const filtered = q ? places.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : places;
  return (
    <div className="stack">
      <input autoFocus placeholder="filtrer…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list" style={{ maxHeight: 180, overflowY: "auto" }}>
        {filtered.map((p) => (
          <button key={p.id} className="ghost" style={{ textAlign: "left" }} onClick={() => onPick(p)}>
            {p.name}
          </button>
        ))}
        {filtered.length === 0 && <div className="muted">Tous les lieux sont déjà placés.</div>}
      </div>
      <button className="ghost" onClick={onClose}>
        Fermer
      </button>
    </div>
  );
}