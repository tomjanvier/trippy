import { useEffect, useMemo } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import type { MapPhotoFeature, Place } from "../api";
import "leaflet/dist/leaflet.css";

const SRC_COLOR: Record<string, string> = { upload: "#4f8cff", instagram: "#e1306c", wordpress: "#38a3c9" };

function Fit({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      const p = points[0]!;
      map.setView(p, 11);
      return;
    }
    map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 14 });
  }, [map, points]);
  return null;
}

function placeIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
    html: '<div style="width:18px;height:18px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#4f8cff;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.5)"></div>',
  });
}

function photoIcon(f: MapPhotoFeature, thumb: string | null): L.DivIcon {
  const color = SRC_COLOR[f.properties.source] ?? "#4f8cff";
  const img = thumb
    ? `<img src="${thumb}" alt="" style="width:100%;height:100%;object-fit:cover" loading="lazy" />`
    : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff">photo</div>';
  return L.divIcon({
    className: "",
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    popupAnchor: [0, -18],
    html: `<div style="width:38px;height:38px;border-radius:50%;overflow:hidden;border:3px solid ${color};background:#0a1222;box-shadow:0 1px 4px rgba(0,0,0,.5)">${img}</div>`,
  });
}

interface Props {
  places?: Place[];
  features?: MapPhotoFeature[];
  /** Rend chaque photo cliquable avec son URL résolue (lien public inclus). */
  photoHref?: (f: MapPhotoFeature) => string;
  small?: boolean;
  /** Clic sur la carte = créer un lieu à cet endroit. */
  onMapClick?: (lat: number, lng: number) => void;
  /** Fin de drag d'une photo = persist sa nouvelle position. */
  onPhotoMoved?: (feature: MapPhotoFeature, lat: number, lng: number) => void;
}

export function TripMap({ places = [], features = [], photoHref, small, onMapClick, onPhotoMoved }: Props) {
  const pIcon = useMemo(placeIcon, []);
  const points = useMemo<[number, number][]>(() => {
    const out: [number, number][] = [];
    for (const p of places) if (p.lat !== null && p.lng !== null) out.push([p.lat, p.lng]);
    for (const f of features) if (f.geometry.coordinates[1] !== null) out.push([f.geometry.coordinates[1], f.geometry.coordinates[0]]);
    return out;
  }, [places, features]);

  return (
    <MapContainer
      center={[46.6, 2.4]}
      zoom={5}
      className={small ? "map small" : "map"}
      scrollWheelZoom
      style={{ cursor: onMapClick ? "crosshair" : undefined }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://openfreemap.org">OpenFreeMap</a>'
        url="https://tiles.openfreemap.org/planet/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      <Fit points={points} />
      <ClickHandler onClick={onMapClick} />
      {places
        .filter((p) => p.lat !== null && p.lng !== null)
        .map((p) => (
          <Marker key={`pl-${p.id}`} position={[p.lat!, p.lng!]} icon={pIcon}>
            <Popup>
              <strong>{p.name}</strong>
              {p.address ? <><br />{p.address}</> : null}
              {p.notes ? <><br /><span style={{ opacity: .8 }}>{p.notes.slice(0, 120)}</span></> : null}
            </Popup>
          </Marker>
        ))}
      {features.map((f) => {
        const [lng, lat] = f.geometry.coordinates;
        if (lat === null || lng === null) return null;
        return (
          <Marker
            key={`ph-${f.properties.id}`}
            position={[lat, lng]}
            icon={photoIcon(f, f.properties.thumbnail)}
            draggable={!!onPhotoMoved}
            eventHandlers={
              onPhotoMoved
                ? {
                    dragend: (e) => {
                      const ll = (e.target as L.Marker).getLatLng();
                      onPhotoMoved(f, ll.lat, ll.lng);
                    },
                  }
                : undefined
            }
          >
            <Popup>
              <strong>{f.properties.source}</strong>
              {f.properties.author ? ` · ${f.properties.author}` : ""}
              {f.properties.caption ? (<><br />{f.properties.caption.slice(0, 160)}</>) : null}
              {photoHref ? (<><br /><a href={photoHref(f)} target="_blank" rel="noreferrer">ouvrir</a></>) : null}
              {onPhotoMoved ? (<><br /><span style={{ opacity: .7 }}>glisse le pin pour déplacer</span></>) : null}
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}

/** Traduit le clic carte en lat/lng (le clic sur un marqueur ne déclenche pas l'ajout). */
function ClickHandler({ onClick }: { onClick?: (lat: number, lng: number) => void }) {
  const map = useMap();
  useEffect(() => {
    if (!onClick) return;
    const handler = (e: L.LeafletMouseEvent) => {
      if ((e.originalEvent.target as HTMLElement)?.closest?.(".leaflet-marker-icon")) return;
      onClick(e.latlng.lat, e.latlng.lng);
    };
    map.on("click", handler);
    return () => {
      map.off("click", handler);
    };
  }, [map, onClick]);
  return null;
}