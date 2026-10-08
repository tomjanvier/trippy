import { useCallback, useEffect, useMemo, useState } from "react";
import { AtlasMap, type AtlasStop } from "../components/AtlasMap";
import { Boundary } from "../components/Boundary";
import { COUNTRIES as ALL_COUNTRIES, countryOfA2, countryOfN3 } from "../data/countries";
import { atlas, type CountrySummary } from "../api";
import { navigate } from "../App";

/**
 * La page d'accueil : l'atlas.
 *
 * Elle remplace la liste des voyages comme point d'entrée. Trois blocs, dans cet
 * ordre de lecture : la carte (le sujet), les compteurs (l'échelle), la table des
 * matières (l'accès par le nom). Le premier n'est pas un titre — un planisphère
 * n'a pas besoin qu'on l'annonce.
 *
 * La carte est l'index : chaque pays est atteignable en cliquant sur son
 * territoire. La table des matières n'est pas un doublon de la carte, c'est la
 * même information dans l'autre sens — celle du nom, que la carte ne sait pas
 * donner. Les deux se partagent le même ordre (dernière visite décroissante),
 * donc elles racontent la même histoire.
 */
export function Home() {
  const [data, setData] = useState<{ countries: CountrySummary[]; totals: { countries: number; photos: number; spots: number } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setData(await atlas.home());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "atlas indisponible");
    }
  }, []);

  useEffect(() => {
    void load();
    // La file hors ligne rejoue les écritures en arrière-plan ; quand elle a
    // fini, l'atlas peut avoir changé.
    const onReplayed = () => void load();
    window.addEventListener("trippy:replayed", onReplayed);
    return () => window.removeEventListener("trippy:replayed", onReplayed);
  }, [load]);

  /**
   * Le fil de voyage. `rank` est l'ordre serveur (le plus récent en premier),
   * réutilisé tel quel comme numéro d'ordre du trait.
   */
  const visited = useMemo(() => {
    const m = new Map<number, AtlasStop>();
    for (const [i, c] of (data?.countries ?? []).entries()) {
      m.set(c.iso_n3, { n3: c.iso_n3, rank: i, visits: Math.max(1, c.visits) });
    }
    return m;
  }, [data]);

  /** Le pays survolé doit être un pays de l'atlas : survoler un territoire non
   *  visité ne doit pas faire apparaître d'étiquette. */
  const hover = (n3: number | null) => setHovered(n3 !== null && visited.has(n3) ? n3 : null);

  const open = (n3: number) => {
    const c = data?.countries.find((x) => x.iso_n3 === n3);
    if (c) navigate(`/country/${c.id}`);
  };

  if (err) {
    return (
      <div>
        <div className="empty">
          <b>L'atlas n'a pas pu se charger.</b>
          <span className="mono">{err}</span>
        </div>
        <button className="ghost" onClick={() => void load()}>
          Réessayer
        </button>
      </div>
    );
  }

  // Le squelette reprend la forme de la mise en page finale : un rectangle bas
  // et large pour la carte, une colonne étroite pour la table. Un cercle de
  // chargement ne dirait rien de la forme de ce qui arrive.
  if (!data) {
    return (
      <div>
        <Boundary>
          <div className="skeleton" style={{ aspectRatio: "2 / 1", maxHeight: "68vh" }} />
        </Boundary>
        <div className="atlas-figures" style={{ margin: "20px 0 24px" }}>
          <div className="skeleton" style={{ width: 72, height: 34 }} />
          <div className="skeleton" style={{ width: 72, height: 34 }} />
          <div className="skeleton" style={{ width: 72, height: 34 }} />
        </div>
        <div className="skeleton" style={{ height: 180 }} />
      </div>
    );
  }

  if (data.countries.length === 0) {
    return (
      <div>
        <div className="empty">
          <b>L'atlas est vide.</b>
          <span style={{ display: "block", maxWidth: "46ch", margin: "0 auto" }}>
            Un pays se pose depuis la page des voyages : ouvre un voyage, et un pays s'y ajoute.
            Il apparaîtra ici, colorié sur la carte, avec ses photos et ses bonnes adresses.
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 18 }}>
          <button onClick={() => navigate("/")}>Voir les voyages</button>
          <button className="ghost" onClick={() => void setPicking(true)}>
            Poser un pays
          </button>
        </div>
        {picking && <CountryPicker onDone={load} onClose={() => setPicking(false)} />}
      </div>
    );
  }

  return (
    <div>
      {/* La carte est gardée à part : si la projection échoue, la table des
          matières doit rester lisible. */}
      <Boundary>
        <AtlasMap visited={visited} hovered={hovered} onHover={hover} onPick={open} />
      </Boundary>

      <div className="atlas-figures" style={{ margin: "18px 0 26px" }}>
        <Figure n={data.totals.countries} label={data.totals.countries === 1 ? "pays visité" : "pays visités"} />
        <Figure n={data.totals.photos} label="photos" />
        <Figure n={data.totals.spots} label={data.totals.spots === 1 ? "bonne adresse" : "bonnes adresses"} />
      </div>

      <section aria-label="Table des matières">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Table des matières</h2>
          <button className="ghost" onClick={() => setPicking(true)}>
            Poser un pays
          </button>
        </div>
        <div className="toc">
          {data.countries.map((c) => (
            <CountryRow key={c.id} country={c} onHover={hover} />
          ))}
        </div>
      </section>

      <Suggestions onAdded={load} />

      <Colophon />
      {picking && <CountryPicker onDone={load} onClose={() => setPicking(false)} />}
    </div>
  );
}

/** Un chiffre, puis son libellé. Le chiffre domine, le libellé s'efface. */
function Figure({ n, label }: { n: number; label: string }) {
  return (
    <div className="atlas-figure">
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}

/**
 * Une entrée de la table des matières : drapeau, nom, note, années, compteurs.
 *
 * Les années viennent du serveur, mais on les reformate ici — `2025-03-01`
 * affiché tel quel sur une page française serait une faute. Le tiret long
 * d'intervalle (–) est distinct du trait d'union, et c'est voulu.
 */
function CountryRow({ country, onHover }: { country: CountrySummary; onHover: (n3: number | null) => void }) {
  const meta = countryOfN3(country.iso_n3);
  const name = meta?.name ?? `Pays ${country.iso_n3}`;
  const years = yearRange(country.visited_from, country.visited_to);

  return (
    <button
      className="toc-row"
      onClick={() => navigate(`/country/${country.id}`)}
      onMouseEnter={() => onHover(country.iso_n3)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="toc-name">
        <span className="toc-flag" aria-hidden="true">
          {meta?.flag ?? ""}
        </span>
        <span style={{ minWidth: 0 }}>
          <b>{name}</b>
          {country.note && <span className="toc-note">{country.note}</span>}
        </span>
        {!meta && <span className="toc-offmap">hors carte</span>}
      </span>
      {/* Les compteurs sont écrits, pas symbolisés. « 3✳ » se lit comme un
          glyphe et demande un effort ; « 3 adresses » se lit du premier coup.
          Ils ne sont affichés que s'ils existent : une table des matières qui
          répète « 0 photo » neuf fois est une table qui ne sert à rien. */}
      <span className="toc-meta">
        {years && <span>{years}</span>}
        {country.visits > 1 && <span className="n">×{country.visits}</span>}
        {country.photos_count > 0 && (
          <span className="n">
            {country.photos_count} photo{country.photos_count > 1 ? "s" : ""}
          </span>
        )}
        {country.spots_count > 0 && (
          <span className="n">
            {country.spots_count} adresse{country.spots_count > 1 ? "s" : ""}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Suggestions : les pays déjà rencontrés dans les journaux et jamais posés sur
 * la carte. C'est le lien entre l'ancien modèle (les voyages) et le nouveau.
 */
function Suggestions({ onAdded }: { onAdded: () => void }) {
  const [items, setItems] = useState<{ country_code: string; last_seen: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    atlas
      .suggestions()
      .then((r) => setItems(r.suggestions))
      .catch(() => setItems([]));
  }, []);

  const add = async (code: string) => {
    const meta = countryOfA2(code);
    if (!meta) return;
    setBusy(true);
    try {
      await atlas.create({ iso_n3: meta.n3 });
      setItems((prev) => prev.filter((x) => x.country_code !== code));
      onAdded();
    } catch {
      /* déjà présent, ou refus de l'API : la liste ne bouge pas */
    } finally {
      setBusy(false);
    }
  };

  if (!items.length) return null;
  return (
    <section aria-label="Pays déjà vus" style={{ marginTop: 28 }}>
      <h3 style={{ marginBottom: 6 }}>Déjà vus dans tes voyages</h3>
      <p className="muted" style={{ margin: "0 0 10px" }}>
        Ces pays apparaissent dans tes journaux mais pas encore sur la carte.
      </p>
      <div className="row">
        {items.map((s) => {
          const meta = countryOfA2(s.country_code);
          if (!meta) return null;
          return (
            <button key={s.country_code} className="ghost" disabled={busy} onClick={() => void add(s.country_code)}>
              {meta.flag} {meta.name}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Poser un pays. Un `<select>` natif plutôt qu'une combobox : il y a 250 pays,
 * c'est une liste, et le natif donne le clavier, le tri et l'accessibilité
 * gratuitement. Chercher à la main n'aurait rien à ajouter.
 */
function CountryPicker({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [n3, setN3] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [visits, setVisits] = useState(1);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = Number(n3);
    if (!n3) return setErr("Choisis un pays.");
    setErr(null);
    setBusy(true);
    try {
      await atlas.create({
        iso_n3: code,
        visited_from: from || null,
        visited_to: to || null,
        visits,
        note: note.trim() || null,
      });
      onDone();
      onClose();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "enregistrement impossible");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Poser un pays sur la carte"
      style={{
        position: "fixed",
        inset: 0,
        background: "#0009",
        display: "grid",
        placeItems: "center",
        padding: 20,
        zIndex: 50,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <form className="card stack" style={{ width: "min(460px, 100%)" }} onSubmit={submit}>
        <h2 style={{ margin: 0 }}>Poser un pays</h2>
        <div>
          <label htmlFor="cp-country">Pays</label>
          <select id="cp-country" value={n3} onChange={(e) => setN3(e.target.value)}>
            <option value="">—</option>
            {ALL_COUNTRIES.map((c) => (
              <option key={c.n3} value={c.n3}>
                {c.flag} {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <div style={{ flex: 1, minWidth: 140 }}>
            <label htmlFor="cp-from">Première visite</label>
            <input id="cp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label htmlFor="cp-to">Dernière visite</label>
            <input id="cp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div style={{ maxWidth: 120 }}>
          <label htmlFor="cp-visits">Allers-retours</label>
          <input id="cp-visits" type="number" min={1} max={1000} value={visits} onChange={(e) => setVisits(Number(e.target.value))} />
        </div>
        <div>
          <label htmlFor="cp-note">Ce que tu en retiens (une ligne)</label>
          <input
            id="cp-note"
            value={note}
            maxLength={400}
            placeholder="le vent, les prix, le café du coin…"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {err && <div className="error">{err}</div>}
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "…" : "Poser"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** L'offre de code source : l'AGPL §13 l'exige dès qu'on sert l'app par le réseau. */
function Colophon() {
  return (
    <footer className="colophon">
      <span>Trippy — carnet de voyage personnel.</span>
      <a href="https://github.com/tomjanvier/trippy" target="_blank" rel="noreferrer noopener">
        code source (AGPL-3.0)
      </a>
      <a href="https://github.com/liketrek/TREK" target="_blank" rel="noreferrer noopener">
        fork de TREK
      </a>
      <span>Carte : Natural Earth (domaine public).</span>
    </footer>
  );
}

/** Années lisibles : « 2025 », « 2019–2025 », ou rien. */
function yearRange(from: string | null, to: string | null): string | null {
  const y = (s: string | null) => (s ? Number(s.slice(0, 4)) : null);
  const a = y(from);
  const b = y(to);
  if (a === null && b === null) return null;
  if (a !== null && b !== null) return a === b ? String(a) : `${a}–${b}`;
  return String(a ?? b);
}

