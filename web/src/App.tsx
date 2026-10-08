import { useCallback, useEffect, useState } from "react";
import { auth, getToken, type User } from "./api";
import { Login } from "./pages/Login";
import { Journeys, JourneyDetail } from "./pages/Journey";
import { OfflineBadge } from "./components/OfflineBadge";
import { Trips } from "./pages/Trips";
import { TripDetail } from "./pages/TripDetail";
import { SharedTrip } from "./pages/SharedTrip";
import { Home } from "./pages/Home";
import { Country } from "./pages/Country";
import { PROJECT_NAME, PROJECT_URL, UPSTREAM_NAME, UPSTREAM_URL } from "./identity";

/**
 * Routage à la main : `pushState` + un `popstate` synthétique, sans dépendance.
 *
 * Trois destinations, donc trois entrées de navigation. Avant c'était deux
 * boutons qui se basculaient l'un l'autre (« Voyages » / « Journaux ») : deux
 * boutons pour deux destinations, c'est une intention dupliquée et un état à
 * deviner. Ici la navigation est une liste, et l'entrée courante est dite.
 */
type Route =
  | { name: "atlas" }
  | { name: "trips" }
  | { name: "trip"; id: number }
  | { name: "country"; id: number }
  | { name: "journeys" }
  | { name: "journey"; id: number }
  | { name: "shared"; token: string };

function parse(): Route {
  const path = window.location.pathname;
  const shared = path.match(/^\/shared\/([A-Za-z0-9_-]+)$/);
  if (shared?.[1]) return { name: "shared", token: shared[1] };
  const country = path.match(/^\/country\/(\d+)$/);
  if (country?.[1]) return { name: "country", id: Number(country[1]) };
  const trip = path.match(/^\/trips\/(\d+)$/);
  if (trip?.[1]) return { name: "trip", id: Number(trip[1]) };
  const journey = path.match(/^\/journey\/(\d+)$/);
  if (journey?.[1]) return { name: "journey", id: Number(journey[1]) };
  if (path === "/trips" || path.startsWith("/trips/")) return { name: "trips" };
  if (path.startsWith("/journeys")) return { name: "journeys" };
  return { name: "atlas" };
}

export function navigate(to: string): void {
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  const [route, setRoute] = useState<Route>(parse);
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const onPop = () => setRoute(parse());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setChecked(true);
      return;
    }
    try {
      setUser(await auth.me());
    } catch {
      setUser(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!checked) {
    return (
      <main style={{ padding: 40, color: "var(--ink-3)" }} className="muted">
        Chargement…
      </main>
    );
  }

  // Page publique : aucun compte requis. Elle rend son propre `<main>`, donc elle
  // court-circuite la coque — c'est le seul cas où c'est possible.
  if (route.name === "shared") {
    return <SharedTrip token={route.token} />;
  }

  if (!user) {
    return <Login onDone={() => void refresh()} />;
  }

  // L'atlas est l'accueil : `/` et `/atlas` y mènent. La largeur est plus large
  // parce qu'une carte a besoin de place.
  const wide = route.name === "atlas" || route.name === "country";

  return (
    <div className="app">
      <header className="topbar">
        {/* Le mot-symbole est un <h1> comme chez Trek, pas un bouton : c'est le
            titre de l'application, et un titre qui est un bouton n'est plus un
            titre pour un lecteur d'écran. Le bouton d'accueil, c'est l'onglet
            « Atlas » juste à côté. */}
        <h1>
          <button className="wordmark" onClick={() => navigate("/atlas")} aria-label={`${PROJECT_NAME} — accueil`}>
            <span className="seal" aria-hidden="true" />
            {PROJECT_NAME}
          </button>
        </h1>
        <div className="row">
          <Tab to="/atlas" label="Atlas" active={route.name === "atlas" || route.name === "country"} />
          <Tab to="/trips" label="Voyages" active={route.name === "trips" || route.name === "trip"} />
          <Tab to="/journeys" label="Journaux" active={route.name === "journeys" || route.name === "journey"} />
        </div>
        <span className="spacer" />
        <span className="muted">{user.username}</span>
        <button
          className="ghost"
          onClick={() => {
            void auth.logout().then(() => {
              setUser(null);
              navigate("/atlas");
            });
          }}
        >
          Déconnexion
        </button>
      </header>
      <OfflineBadge />
      <main className={wide ? "atlas" : undefined}>
        {route.name === "atlas" ? (
          <Home />
        ) : route.name === "country" ? (
          <Country id={route.id} />
        ) : route.name === "trips" ? (
          <Trips user={user} />
        ) : route.name === "trip" ? (
          <TripDetail id={route.id} />
        ) : route.name === "journeys" ? (
          <Journeys />
        ) : (
          <JourneyDetail id={route.id} />
        )}
      </main>
    </div>
  );
}

/**
 * Un onglet de navigation, au style `ghost` de Trek : transparent, bordure
 * `--line`, texte `--text`. L'entrée courante se distingue par un fond
 * `bg-soft` et `aria-current="page"` — pas par un nouveau style.
 *
 * Trek avait deux boutons qui se basculaient l'un l'autre ; il y a désormais trois
 * destinations, donc trois entrées, ce qui est la seule adaptation nécessaire ici.
 */
function Tab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <button
      className={active ? "ghost on" : "ghost"}
      aria-current={active ? "page" : undefined}
      onClick={() => navigate(to)}
    >
      {label}
    </button>
  );
}

/**
 * L'offre de code source exigée par l'AGPL-3.0 §13 : dès lors que quelqu'un
 * interagit avec Trippy par le réseau, l'application doit proposer sans frais le
 * code source correspondant. Le lien est donc dans la page, pas dans un
 * « à propos » à retrouver.
 */
export function SourceNotice() {
  return (
    <span className="colophon">
      <span>
        {PROJECT_NAME} — fork modifié de{" "}
        <a href={UPSTREAM_URL} target="_blank" rel="noreferrer noopener">
          {UPSTREAM_NAME}
        </a>
        , sous AGPL-3.0.
      </span>
      <a href={PROJECT_URL} target="_blank" rel="noreferrer noopener">
        code source
      </a>
    </span>
  );
}
