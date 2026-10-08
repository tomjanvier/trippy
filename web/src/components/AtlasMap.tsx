import { useEffect, useMemo, useState } from "react";
import {
  geoCentroid,
  geoGraticule10,
  geoInterpolate,
  geoNaturalEarth1,
  geoPath,
  type GeoPermissibleObjects,
} from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry, LineString } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";

/**
 * La carte du monde de l'atlas.
 *
 * Ce n'est pas Leaflet, et ce n'est pas un oubli. Leaflet sert des tuiles pour
 * une carte à zoomer ; or il n'y a rien à zoomer sur la page d'accueil. Ce qu'il
 * faut est un planisphère dessiné une fois, où un pays visité est une encre et
 * sur lequel on peut cliquer. Des tuiles apporteraient une attribution OSM, un
 * contrôle de zoom et 300 Ko d'images pour dessiner exactement les mêmes formes.
 *
 * Géométrie : Natural Earth 1:110m, domaine public, via le paquet `world-atlas`.
 * 110m plutôt que 50m parce que 105 Ko valent mieux que 739 Ko, et que l'écart
 * ne porte que sur les micro-États. Un pays enregistré sans contour à cette
 * échelle est signalé dans la table des matières plutôt que de disparaître
 * sans explication.
 *
 * Projection Natural Earth 1 : celle des atlas scolaires. Elle préserve à peu
 * près la taille des plateaux d'Asie, là où Mercator gonfle le Groenland — sur
 * une carte de pays visités, ce serait précisément la faute à éviter.
 *
 * Le TopoJSON est chargé par `import()` : il pèse 105 Ko et n'a rien à faire
 * dans le premier rendu. La coquille — titre, compteurs, table des matières —
 * s'affiche et est lisible pendant que la géométrie arrive. Le squelette occupe
 * exactement la place que la carte prendra, donc rien ne saute ensuite.
 */

/** viewBox fixe : le SVG est redimensionné par CSS, donc les coordonnées
 *  internes n'ont pas à suivre le pixel. La carte reste nette à toute largeur,
 *  et un zoom du navigateur ne vectorise rien. */
const W = 1000;
const H = 500;

function projection() {
  return geoNaturalEarth1().fitExtent(
    [
      [4, 6],
      [W - 4, H - 6],
    ],
    { type: "Sphere" } as GeoPermissibleObjects,
  );
}

interface Prepared {
  /** Contour d'un pays, indexé par code ISO numérique. */
  outlines: Map<number, string>;
  /** Contour des continents, derrière les frontières. */
  shore: string;
  graticule: string;
  /** Contour de la sphère : sert de `clipPath` au fil et aux points. */
  sphere: string;
  /** Nom anglais du TopoJSON : seul repli quand le nom français manque. */
  names: Map<number, string>;
  /**
   * Centroïde projeté de chaque pays. Sert d'ancre au fil de voyage et
   * d'étiquette au survol. Calculé une fois : `geoCentroid` parcourt la
   * géométrie entière, le refaire à chaque survol serait du travail inutile.
   */
  anchors: Map<number, { x: number; y: number }>;
  /** Les mêmes centroïdes en longitude/latitude, pour interpoler un grand cercle. */
  centroids: Map<number, [number, number]>;
}

let cached: Promise<Prepared> | null = null;

/**
 * Géométrie partagée par toutes les cartes de la session. La promesse est mise
 * en cache : revenir de la page d'un pays à l'atlas ne doit pas re-parser
 * 105 Ko de coordonnées.
 */
function loadWorld(): Promise<Prepared> {
  cached ??= import("world-atlas/countries-110m.json").then((mod) => {
    const topo = mod.default as unknown as Topology<{ countries: GeometryCollection; land: GeometryCollection }>;
    const countries = feature(topo, topo.objects.countries) as unknown as FeatureCollection<
      Geometry,
      { name: string }
    >;
    const land = feature(topo, topo.objects.land) as unknown as FeatureCollection<Geometry>;

    const proj = projection();
    const path = geoPath(proj);
    const outlines = new Map<number, string>();
    const names = new Map<number, string>();
    const anchors = new Map<number, { x: number; y: number }>();
    const centroids = new Map<number, [number, number]>();

    for (const f of countries.features) {
      const n3 = Number(f.id);
      if (!Number.isFinite(n3)) continue;
      const d = path(f as unknown as GeoPermissibleObjects) ?? "";
      // Un pays sans contour projeté à cette échelle est laissé de côté : mieux
      // vaut une carte un peu moins détaillée qu'un `<path>` vide.
      if (!d) continue;
      outlines.set(n3, d);
      if (f.properties?.name) names.set(n3, f.properties.name);
      const centroid = geoCentroid(f as unknown as GeoPermissibleObjects);
      const c = proj(centroid);
      if (c) anchors.set(n3, { x: c[0], y: c[1] });
      centroids.set(n3, centroid);
    }

    return {
      outlines,
      shore: path(land as unknown as GeoPermissibleObjects) ?? "",
      graticule: path(geoGraticule10()) ?? "",
      sphere: path({ type: "Sphere" } as GeoPermissibleObjects) ?? "",
      names,
      anchors,
      centroids,
    };
  });
  return cached;
}

export interface AtlasStop {
  n3: number;
  /** Rang chronologique décroissant, 0 = le plus récent. */
  rank: number;
  /** Nombre d'allers-retours : décide de la densité d'encre. */
  visits: number;
}

export interface AtlasMapProps {
  /** Pays visités, indexés par code ISO numérique. */
  visited: Map<number, AtlasStop>;
  onPick: (n3: number) => void;
  hovered: number | null;
  onHover: (n3: number | null) => void;
}

/**
 * La coque : attend la géométrie, puis dessine. Le carré de chargement a les
 * proportions exactes du SVG, donc l'a swap ne décale rien.
 */
export function AtlasMap(props: AtlasMapProps) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    loadWorld().then(
      (p) => {
        if (alive) setPrepared(p);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    // `alive` évite le classique « setState sur un composant démonté » quand on
    // quitte la page pendant le chargement des 105 Ko.
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <div className="atlas-map">
        <div className="empty" style={{ border: 0 }}>
          <b>La carte n'a pas pu se charger.</b>
          Les pays restent accessibles par la table des matières.
        </div>
      </div>
    );
  }

  if (!prepared) {
    return (
      <div className="atlas-map">
        <div className="skeleton" style={{ width: "100%", height: "100%" }} />
      </div>
    );
  }

  return <WorldMap prepared={prepared} {...props} />;
}

function WorldMap({
  prepared,
  visited,
  onPick,
  hovered,
  onHover,
}: AtlasMapProps & { prepared: Prepared }) {
  /**
   * Le fil de voyage. Le serveur renvoie déjà les pays triés du plus récent au
   * plus ancien : il suffit de relier les ancres dans cet ordre. Moins de deux
   * pays, pas de fil — un trait unique n'est pas un voyage.
   */
  const thread = useMemo(() => {
    const ordered = [...visited.values()].sort((a, b) => a.rank - b.rank);
    const stops: { n3: number; x: number; y: number }[] = [];
    const coords: [number, number][] = [];
    for (const s of ordered) {
      const a = prepared.anchors.get(s.n3);
      if (!a) continue;
      stops.push({ n3: s.n3, x: a.x, y: a.y });
      coords.push(prepared.centroids.get(s.n3)!);
    }
    if (stops.length < 2) return { line: "", stops: [] as typeof stops };

    // Un trait droit entre deux centroïdes de part et d'autre de l'antiméridien
    // fait levers le tracé hors du planisphère : d3 découpe le polygone au
    // passage de ±180°, mais le segment Rotterdam–Chili ressort par le bas et
    // traverse toute la page. Deux corrections, donc :
    //
    //   a) on relie chaque étape à la suivante par son GRAND CERCLE, interpolé.
    //      C'est le chemin le plus court sur la sphère, et cela ressemble enfin
    //      à un itinéraire ;
    //   b) le fil est découpé sur la sphère, donc rien ne peut déborder même si
    //      un tracé passe derrière la Terre.
    //
    // 24 échantillons par étape suffisent : l'arc le plus long possible fait
    // moins de 180°, et 24 points le rendent lisse à l'échelle de l'écran.
    const proj = projection();
    const path = geoPath(proj);
    const line: string[] = [];
    for (let i = 0; i + 1 < coords.length; i++) {
      const a = coords[i]!;
      const b = coords[i + 1]!;
      const interp = geoInterpolate(a, b);
      const seg: [number, number][] = [];
      for (let k = 0; k <= 24; k++) seg.push(interp(k / 24));
      line.push(path({ type: "LineString", coordinates: seg } as LineString) ?? "");
    }
    return { line: line.join(" "), stops };
  }, [visited, prepared]);

  // L'étiquette n'apparaît que pour un pays de l'atlas : survoler un territoire
  // non visité ne doit rien déclencher.
  const hoverN3 = hovered !== null && visited.has(hovered) ? hovered : null;
  const hoverAnchor = hoverN3 === null ? null : (prepared.anchors.get(hoverN3) ?? null);

  return (
    <div className="atlas-map">
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Carte des pays visités">
        {/* L'océan, c'est la page : aucun fond dessiné, la couleur de --paper
            montre à travers. C'est ce qui fait lire la carte comme un atlas et
            non comme un composant d'interface posé sur un fond. */}
        <g aria-hidden="true">
          <path className="atlas-graticule" d={prepared.graticule} />
          <path className="atlas-land" d={prepared.shore} strokeWidth={0.7} fillRule="evenodd" />
        </g>

        {/*
          Le fil passe sous les territoires — il doit relier sans masquer — et il
          est découpé sur la sphère. Sans cette découpe, un grand cercle passant
          derrière la Terre ressort du planisphère et traverse la page entière.
        */}
        <clipPath id="atlas-sphere">
          <path d={prepared.sphere} />
        </clipPath>
        <g clipPath="url(#atlas-sphere)">
          <path className="atlas-thread" d={thread.line} />
        </g>

        <g>
          {[...prepared.outlines].map(([n3, d]) => {
            const stop = visited.get(n3);
            if (!stop) return <path key={`c${n3}`} className="atlas-land" d={d} />;
            const name = prepared.names.get(n3) ?? String(n3);
            return (
              <path
                key={`v${n3}`}
                className="atlas-visited"
                d={d}
                // Cinq paliers d'encre : au-delà, l'œil ne distingue plus rien et
                // l'encodage promet une précision qu'il n'a pas.
                data-visits={Math.min(Math.max(stop.visits, 1), 5)}
                tabIndex={0}
                role="link"
                aria-label={name}
                onClick={() => onPick(n3)}
                onMouseEnter={() => onHover(n3)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(n3)}
                onBlur={() => onHover(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPick(n3);
                  }
                }}
              />
            );
          })}
        </g>

        <g clipPath="url(#atlas-sphere)">
          {thread.stops.map((s) => (
            <circle key={`s${s.n3}`} className="atlas-stop" cx={s.x} cy={s.y} r={2.2} />
          ))}
        </g>

        {/* L'étiquette n'existe que pendant le survol : au repos la carte reste
            calme, et rien n'y bouge au chargement. */}
        {hoverN3 !== null && hoverAnchor && (
          <text className="atlas-tip" x={hoverAnchor.x + 9} y={hoverAnchor.y - 9}>
            {prepared.names.get(hoverN3)}
          </text>
        )}
      </svg>
      <span className="atlas-scale">NATURAL EARTH 1:110M</span>
    </div>
  );
}
