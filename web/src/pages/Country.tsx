import { useCallback, useEffect, useRef, useState } from "react";
import { atlas, type Country, type CountryPhoto, type Spot } from "../api";
import { navigate } from "../App";
import { countryOfN3 } from "../data/countries";
import { SPOT_KIND_LABELS, SPOT_KIND_ORDER, spotKindLabel } from "../data/spots";

/**
 * La page d'un pays : le récit, les photos, les bonnes adresses.
 *
 * Trois blocs séparés par des filets, jamais par des cartes. Un pays est un
 * dossier, pas une fiche produit : il faut pouvoir le lire d'un trait et le
 * parcourir en diagonale.
 *
 * L'ordre est celui du carnet : d'abord ce que c'est (nom, années, une ligne),
 * puis ce qu'on y a vécu (le récit), puis les preuves (les photos), puis ce qu'on
 * en conseille (les adresses). Une « bonne adresse » n'a de valeur qu'après la
 * photo qui la situe — d'où cet ordre, et non l'inverse.
 */
export function Country({ id }: { id: number }) {
  const [country, setCountry] = useState<Country | null>(null);
  const [photos, setPhotos] = useState<CountryPhoto[]>([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const d = await atlas.get(id);
      setCountry(d.country);
      setPhotos(d.photos);
      setSpots(d.spots);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "pays indisponible");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const meta = country ? countryOfN3(country.iso_n3) : null;
  const name = meta?.name ?? (country ? `Pays ${country.iso_n3}` : "");
  const years = yearRange(country?.visited_from ?? null, country?.visited_to ?? null);

  if (err) {
    return (
      <div>
        <div className="empty">
          <b>Ce pays n'est pas dans l'atlas.</b>
          <span className="mono">{err}</span>
        </div>
        <div style={{ marginTop: 16 }}>
          <button className="ghost" onClick={() => navigate("/atlas")}>
            Retour à l'atlas
          </button>
        </div>
      </div>
    );
  }

  if (!country) {
    return (
      <div>
        <div className="skeleton" style={{ height: 92 }} />
        <div className="skeleton" style={{ height: 200, marginTop: 20 }} />
      </div>
    );
  }

  return (
    <div>
      <header className="country-head">
        <div className="country-title">
          {meta && (
            <span className="flag" aria-hidden="true">
              {meta.flag}
            </span>
          )}
          <h2>{name}</h2>
        </div>
        <div className="country-when">
          {years && <span>{years}</span>}
          {country.visits > 1 && <div>×{country.visits} allers-retours</div>}
        </div>
        {country.note && <p className="country-note">{country.note}</p>}
        {country.story && <p className="country-story">{country.story}</p>}
      </header>

      <section aria-label="Photos" style={{ marginBottom: 32 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Photos</h2>
          <AddPhoto countryId={country.id} onAdded={load} />
        </div>
        <ContactSheet photos={photos} onChanged={load} busy={busy} setBusy={setBusy} />
      </section>

      <section aria-label="Bonnes adresses">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Bonnes adresses</h2>
          <AddSpot countryId={country.id} onAdded={load} />
        </div>
        <Finds spots={spots} onChanged={load} />
      </section>

      <footer className="colophon">
        <button className="ghost danger" onClick={() => void remove(country.id)}>
          Retirer ce pays de l'atlas
        </button>
        <button className="ghost" onClick={() => navigate("/atlas")}>
          Retour à l'atlas
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- planche-contact

/**
 * Les photos en planche-contact : grille d'un pixel, cadre fileté, angle droit.
 *
 * La grille fait le filet elle-même (`gap: 1px` sur un fond `--rule`), donc
 * chaque photo n'a pas sa propre bordure : une seule ligne, continue, comme sur
 * une bande de négatif.
 *
 * Le format est fixe (4/5) et `object-fit: cover` : le navigateur réserve la
 * place avant le chargement, donc rien ne saute à l'arrivée des images. Sans
 * cela, la page se réorganiserait sous les yeux à chaque photo.
 */
function ContactSheet({
  photos,
  onChanged,
  busy,
  setBusy,
}: {
  photos: CountryPhoto[];
  onChanged: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  if (!photos.length) {
    return (
      <div className="contact-empty">
        Aucune photo. Un lien suffit — une image déjà en ligne, ou un fichier envoyé depuis l'appareil.
      </div>
    );
  }
  return (
    <div className="contact">
      {photos.map((p) => (
        <figure key={p.id}>
          <img
            src={p.r2_key ? atlas.photoFile(p.id) : (p.external_url ?? "")}
            alt={p.caption ?? ""}
            loading="lazy"
            decoding="async"
          />
          <figcaption>
            {p.taken_on && <time>{p.taken_on.slice(0, 7).replace("-", ".")}</time>}
            <span>{p.caption ?? ""}</span>
          </figcaption>
          <button
            className="ghost drop"
            disabled={busy}
            aria-label={`Retirer la photo ${p.id}`}
            onClick={async () => {
              if (!confirm("Retirer cette photo ?")) return;
              setBusy(true);
              try {
                await atlas.removePhoto(p.id);
                onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            Retirer
          </button>
        </figure>
      ))}
    </div>
  );
}

function AddPhoto({ countryId, onAdded }: { countryId: number; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [taken, setTaken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (caption.trim()) form.append("caption", caption.trim());
      if (taken) form.append("taken_on", taken);
      await atlas.uploadPhoto(countryId, form);
      setCaption("");
      setTaken("");
      setOpen(false);
      onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "envoi impossible");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const link = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await atlas.linkPhoto(countryId, {
        external_url: url.trim(),
        caption: caption.trim() || null,
        taken_on: taken || null,
      });
      setUrl("");
      setCaption("");
      setTaken("");
      setOpen(false);
      onAdded();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "lien refusé");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="ghost" onClick={() => setOpen(true)}>
        Ajouter une photo
      </button>
    );
  }

  return (
    <div className="card stack" style={{ width: "min(420px, 100%)" }}>
      <div>
        <label htmlFor="ph-file">Depuis l'appareil</label>
        <input
          id="ph-file"
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
      <div className="divider" />
      <form className="stack" onSubmit={link}>
        <div>
          <label htmlFor="ph-url">Ou par lien</label>
          <input
            id="ph-url"
            type="url"
            value={url}
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="row">
          <div style={{ flex: 2, minWidth: 180 }}>
            <label htmlFor="ph-cap">Légende</label>
            <input id="ph-cap" value={caption} maxLength={1000} onChange={(e) => setCaption(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 130 }}>
            <label htmlFor="ph-date">Prise le</label>
            <input id="ph-date" type="date" value={taken} onChange={(e) => setTaken(e.target.value)} />
          </div>
        </div>
        {err && <div className="error">{err}</div>}
        <div className="row end">
          <button type="button" className="ghost" onClick={() => setOpen(false)}>
            Annuler
          </button>
          <button type="submit" disabled={busy || !url.trim()}>
            {busy ? "…" : "Ajouter"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- bonnes adresses

/**
 * Les adresses, groupées par catégorie et dans l'ordre de `SPOT_KIND_ORDER` :
 * manger, boire, dormir, voir, marcher, acheter. C'est l'ordre dans lequel on
 * cherche une adresse (« on va manger où ? »), pas l'ordre alphabétique.
 *
 * Le `verdict` est la donnée. Il est donc en corps de texte, pas en gris
 * secondaire : c'est la phrase qu'on a écrite pour s'en souvenir.
 */
function Finds({ spots, onChanged }: { spots: Spot[]; onChanged: () => void }) {
  if (!spots.length) {
    return (
      <div className="contact-empty">
        Aucune adresse notée. Le resto où tu mangerais encore, le café où tu t'asseoirais une heure
        entière, l'hôtel où tu reviendrais sans réfléchir.
      </div>
    );
  }
  const groups = SPOT_KIND_ORDER.map((k) => ({ kind: k, items: spots.filter((s) => s.kind === k) })).filter(
    (g) => g.items.length > 0,
  );
  const orphans = spots.filter((s) => !SPOT_KIND_ORDER.includes(s.kind as never));
  if (orphans.length) groups.push({ kind: "other", items: orphans });

  return (
    <>
      {groups.map((g) => (
        <div key={g.kind} style={{ marginBottom: 22 }}>
          <div className="find-group">
            <h3>{spotKindLabel(g.kind)}</h3>
            <p className="find-group-hint">{SPOT_KIND_LABELS[g.kind]?.hint}</p>
          </div>
          <div className="finds">
            {g.items.map((s) => (
              <Find key={s.id} spot={s} onChanged={onChanged} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function Find({ spot, onChanged }: { spot: Spot; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <article className="find">
      {/* Pas de catégorie ici : la liste est DÉJÀ groupée par catégorie, donc la
          répéter sur chaque ligne affichait deux fois la même information. */}
      <strong className="find-name">
        {spot.url ? (
          <a href={spot.url} target="_blank" rel="noreferrer noopener">
            {spot.name}
          </a>
        ) : (
          spot.name
        )}
      </strong>
      {spot.city && <span className="find-city">{spot.city}</span>}
      <span className="find-meta">
        {spot.price_cents !== null && <span>{euros(spot.price_cents)}</span>}
        {spot.visited_on && <time>{spot.visited_on.slice(0, 7).replace("-", ".")}</time>}
        <button
          className="ghost"
          disabled={busy}
          aria-label={`Retirer ${spot.name}`}
          onClick={async () => {
            if (!confirm(`Retirer « ${spot.name} » ?`)) return;
            setBusy(true);
            try {
              await atlas.removeSpot(spot.id);
              onChanged();
            } finally {
              setBusy(false);
            }
          }}
        >
          Retirer
        </button>
      </span>
      {spot.verdict && <p className="find-verdict">{spot.verdict}</p>}
    </article>
  );
}

function AddSpot({ countryId, onAdded }: { countryId: number; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("eat");
  const [city, setCity] = useState("");
  const [verdict, setVerdict] = useState("");
  const [url, setUrl] = useState("");
  const [price, setPrice] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await atlas.addSpot(countryId, {
        name: name.trim(),
        kind,
        city: city.trim() || null,
        verdict: verdict.trim() || null,
        url: url.trim() || null,
        // Le prix saisi est en euros ; le schéma stocke des centimes, comme
        // partout ailleurs dans l'application.
        price_cents: price.trim() ? Math.round(Number(price) * 100) : null,
      });
      setName("");
      setVerdict("");
      setCity("");
      setUrl("");
      setPrice("");
      setOpen(false);
      onAdded();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "enregistrement impossible");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="ghost" onClick={() => setOpen(true)}>
        Noter une adresse
      </button>
    );
  }

  return (
    <form className="card stack" style={{ width: "min(460px, 100%)" }} onSubmit={submit}>
      <h3 style={{ margin: 0 }}>Nouvelle adresse</h3>
      <div className="row">
        <div style={{ flex: 2, minWidth: 180 }}>
          <label htmlFor="sp-name">Nom</label>
          <input id="sp-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ flex: 1, minWidth: 130 }}>
          <label htmlFor="sp-kind">Catégorie</label>
          <select id="sp-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {SPOT_KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {SPOT_KIND_LABELS[k]!.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <div style={{ flex: 1, minWidth: 150 }}>
          <label htmlFor="sp-city">Ville</label>
          <input id="sp-city" value={city} maxLength={120} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div style={{ flex: 1, minWidth: 110 }}>
          <label htmlFor="sp-price">Prix (€)</label>
          <input
            id="sp-price"
            type="number"
            min={0}
            step="0.5"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
      </div>
      <div>
        {/* Le libellé est AU-DESSUS, l'aide en dessous, l'erreur sous le champ.
            Jamais de placeholder en guise de libellé : il disparaît à la
            première frappe. */}
        <label htmlFor="sp-verdict">Ce que tu en penses</label>
        <textarea
          id="sp-verdict"
          rows={3}
          value={verdict}
          maxLength={1000}
          placeholder="La meilleure table de la ville, et ils ne réservent pas."
          onChange={(e) => setVerdict(e.target.value)}
        />
        <span className="muted">Une phrase suffit. C'est elle qu'on relit dans deux ans.</span>
      </div>
      <div>
        <label htmlFor="sp-url">Lien</label>
        <input id="sp-url" type="url" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row end">
        <button type="button" className="ghost" onClick={() => setOpen(false)}>
          Annuler
        </button>
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? "…" : "Noter"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- actions

async function remove(id: number): Promise<void> {
  if (!confirm("Retirer ce pays de l'atlas ? Ses photos et ses adresses seront supprimées.")) return;
  await atlas.remove(id);
  navigate("/atlas");
}

/** Centimes → euros, à la française. Aligné sur `euro()` de TripLists.tsx. */
function euros(cents: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);
}

function yearRange(from: string | null, to: string | null): string | null {
  const y = (s: string | null) => (s ? Number(s.slice(0, 4)) : null);
  const a = y(from);
  const b = y(to);
  if (a === null && b === null) return null;
  if (a !== null && b !== null) return a === b ? String(a) : `${a}–${b}`;
  return String(a ?? b);
}
