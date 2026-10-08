import { useEffect, useState } from "react";
import {
  trips,
  type BudgetItem,
  type PackingItem,
  type Reservation,
  type TodoItem,
} from "../api";

const euro = (cents: number, currency?: string | null) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency || "EUR" }).format(cents / 100);

/** ---------- réservations ---------- */
export function Reservations({ tripId, days, onFlash }: { tripId: number; days: { id: number; day_number: number }[]; onFlash: (m: string) => void }) {
  const [items, setItems] = useState<Reservation[]>([]);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("flight");
  const [dayId, setDayId] = useState("");
  const [cost, setCost] = useState("");

  const load = async () => {
    try {
      setItems(await trips.reservations(tripId));
    } catch (e) {
      onFlash(`Erreur : ${e instanceof Error ? e.message : "réservations indisponibles"}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  return (
    <div className="card stack">
      <h3>Réservations</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void trips
            .addReservation(tripId, {
              title: title.trim(),
              type,
              day_id: dayId ? Number(dayId) : null,
              cost_cents: cost ? Math.round(Number(cost) * 100) : null,
            })
            .then(() => {
              setTitle("");
              setCost("");
              void load();
            })
            .catch((e2: Error) => onFlash(`Erreur : ${e2.message}`));
          e.preventDefault();
        }}
      >
        <input style={{ flex: 1 }} placeholder="Vol AF1234, Hôtel…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select style={{ width: 140 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="flight">Avion</option>
          <option value="train">Train</option>
          <option value="bus">Bus</option>
          <option value="car">Voiture</option>
          <option value="ferry">Ferry</option>
          <option value="restaurant">Restaurant</option>
          <option value="museum">Musée</option>
          <option value="activity">Activité</option>
          <option value="other">Autre</option>
        </select>
        <select style={{ width: 110 }} value={dayId} onChange={(e) => setDayId(e.target.value)}>
          <option value="">— jour —</option>
          {days.map((d) => (
            <option key={d.id} value={d.id}>
              J{d.day_number}
            </option>
          ))}
        </select>
        <input style={{ width: 110 }} placeholder="€" value={cost} onChange={(e) => setCost(e.target.value)} />
        <button type="submit">Ajouter</button>
      </form>
      <div className="list">
        {items.map((r) => (
          <div className="list-item" key={r.id}>
            <div>
              <strong>{r.title}</strong>
              <div className="muted">
                {r.type}
                {r.day_number ? ` · J${r.day_number}` : ""}
                {r.cost_cents ? ` · ${euro(r.cost_cents, r.currency)}` : ""}
                {r.confirmation_number ? ` · ${r.confirmation_number}` : ""}
              </div>
            </div>
            <div className="row">
              <select
                value={r.status}
                onChange={(e) => {
                  void trips.updateReservation(tripId, r.id, { status: e.target.value }).then(() => void load());
                }}
              >
                <option value="pending">En attente</option>
                <option value="confirmed">Confirmé</option>
                <option value="cancelled">Annulé</option>
              </select>
              <button
                className="danger"
                onClick={() => {
                  if (confirm(`Supprimer « ${r.title} » ?`)) void trips.deleteReservation(tripId, r.id).then(() => void load());
                }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="muted">Aucune réservation.</div>}
      </div>
    </div>
  );
}

/** ---------- budget ---------- */
export function Budget({ tripId, onFlash }: { tripId: number; onFlash: (m: string) => void }) {
  const [items, setItems] = useState<BudgetItem[]>([]);
  const [total, setTotal] = useState(0);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Hébergement");

  const load = async () => {
    try {
      const r = await trips.budget(tripId);
      setItems(r.budget_items);
      setTotal(r.total_cents);
    } catch (e) {
      onFlash(`Erreur : ${e instanceof Error ? e.message : "budget indisponible"}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  return (
    <div className="card stack">
      <h3>Budget · {euro(total)}</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !amount) return;
          void trips
            .addBudgetItem(tripId, {
              name: name.trim(),
              category,
              total_cents: Math.round(Number(amount) * 100),
            })
            .then(() => {
              setName("");
              setAmount("");
              void load();
            })
            .catch((e2: Error) => onFlash(`Erreur : ${e2.message}`));
          e.preventDefault();
        }}
      >
        <input style={{ flex: 1 }} placeholder="Dépense" value={name} onChange={(e) => setName(e.target.value)} />
        <select style={{ width: 150 }} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option>Hébergement</option>
          <option>Transport</option>
          <option>Restauration</option>
          <option>Activités</option>
          <option>Shopping</option>
          <option>Autre</option>
        </select>
        <input style={{ width: 100 }} placeholder="€" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button type="submit">Ajouter</button>
      </form>
      <div className="list">
        {items.map((b) => (
          <div className="list-item" key={b.id}>
            <div>
              <strong>{b.name}</strong>
              <div className="muted">
                {b.category}
                {b.persons ? ` · ${b.persons} pers.` : ""}
              </div>
            </div>
            <div className="row">
              <span>{euro(b.total_cents, b.currency)}</span>
              <button
                className="danger"
                onClick={() => {
                  if (confirm(`Supprimer « ${b.name} » ?`)) void trips.deleteBudgetItem(tripId, b.id).then(() => void load());
                }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="muted">Aucune dépense.</div>}
      </div>
    </div>
  );
}

/** ---------- liste de préparation ---------- */
export function Packing({ tripId, onFlash }: { tripId: number; onFlash: (m: string) => void }) {
  const [items, setItems] = useState<PackingItem[]>([]);
  const [checked, setChecked] = useState(0);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");

  const load = async () => {
    try {
      const r = await trips.packing(tripId);
      setItems(r.packing_items);
      setChecked(r.checked);
    } catch (e) {
      onFlash(`Erreur : ${e instanceof Error ? e.message : "liste indisponible"}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  const byCat = new Map<string, PackingItem[]>();
  for (const it of items) {
    const k = it.category || "Divers";
    byCat.set(k, [...(byCat.get(k) ?? []), it]);
  }

  return (
    <div className="card stack">
      <h3>Liste de préparation · {checked}/{items.length}</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void trips
            .addPackingItem(tripId, { name: name.trim(), category: category || null })
            .then(() => {
              setName("");
              void load();
            })
            .catch((e2: Error) => onFlash(`Erreur : ${e2.message}`));
          e.preventDefault();
        }}
      >
        <input style={{ flex: 1 }} placeholder="Objet à emporter" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ width: 140 }} placeholder="Catégorie" value={category} onChange={(e) => setCategory(e.target.value)} />
        <button type="submit">Ajouter</button>
      </form>
      {[...byCat].map(([cat, list]) => (
        <div className="stack" key={cat}>
          <div className="muted">{cat}</div>
          <div className="list">
            {list.map((it) => (
              <div className="list-item" key={it.id}>
                <label className="row" style={{ gap: 8, margin: 0 }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={!!it.checked}
                    onChange={(e) => {
                      void trips
                        .updatePackingItem(tripId, it.id, { checked: e.target.checked ? 1 : 0 })
                        .then(() => void load());
                    }}
                  />
                  <span style={{ textDecoration: it.checked ? "line-through" : undefined }}>{it.name}</span>
                </label>
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm(`Supprimer « ${it.name} » ?`)) void trips.deletePackingItem(tripId, it.id).then(() => void load());
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
      {items.length === 0 && <div className="muted">Liste vide.</div>}
    </div>
  );
}

/** ---------- to-do ---------- */
export function Todos({ tripId, onFlash }: { tripId: number; onFlash: (m: string) => void }) {
  const [items, setItems] = useState<TodoItem[]>([]);
  const [name, setName] = useState("");
  const [due, setDue] = useState("");

  const load = async () => {
    try {
      setItems(await trips.todos(tripId));
    } catch (e) {
      onFlash(`Erreur : ${e instanceof Error ? e.message : "todos indisponibles"}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  return (
    <div className="card stack">
      <h3>À faire</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void trips
            .addTodo(tripId, { name: name.trim(), due_date: due || null })
            .then(() => {
              setName("");
              setDue("");
              void load();
            })
            .catch((e2: Error) => onFlash(`Erreur : ${e2.message}`));
          e.preventDefault();
        }}
      >
        <input style={{ flex: 1 }} placeholder="Réserver un taxi" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ width: 170 }} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button type="submit">Ajouter</button>
      </form>
      <div className="list">
        {items.map((t) => (
          <div className="list-item" key={t.id}>
            <label className="row" style={{ gap: 8, margin: 0 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={!!t.checked}
                onChange={(e) => {
                  void trips.updateTodo(tripId, t.id, { checked: e.target.checked ? 1 : 0 }).then(() => void load());
                }}
              />
              <span>
                {t.name}
                {t.due_date && <span className="muted"> · {t.due_date}</span>}
              </span>
            </label>
            <button
              className="danger"
              onClick={() => {
                if (confirm(`Supprimer « ${t.name} » ?`)) void trips.deleteTodo(tripId, t.id).then(() => void load());
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {items.length === 0 && <div className="muted">Rien à faire. Château d'eau.</div>}
      </div>
    </div>
  );
}