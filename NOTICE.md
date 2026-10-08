# Third-party data & attributions

Trippy is a fork of [TREK](https://github.com/liketrek/TREK), redistributed under
AGPL-3.0. It calls the services and bundles the data listed below, all of which
require attribution.

## OpenStreetMap — geocoding, search & POI

Place search and reverse geocoding go through **Nominatim**, and category POIs
come from **Overpass**. Data is © OpenStreetMap contributors, licensed under the
Open Database License (ODbL).
<https://www.openstreetmap.org/copyright>

Both are called with a bounded fetch (`src/lib/geo.ts`): an identifying
User-Agent, a timeout, and a hard cap on response size.

## Photon — search autocomplete

Search also fans out to **Photon** (`photon.komoot.io`), a free Nominatim-backed
geocoder run by komoot. See <https://photon.komoot.io/> and komoot's terms.

## OSRM — routing

Itineraries use the **OSRM** demo servers operated by Project OSRM and by
`routing.openstreetmap.de`, on OpenStreetMap data (ODbL, above).
See <https://project-osrm.org/>.

## OpenFreeMap / OpenMapTiles — raster map tiles

The per-trip map tiles come from `tiles.openfreemap.org`. See
<https://openfreemap.org/> and the OpenMapTiles terms.

## Natural Earth — the world atlas on the home page

The world map is drawn from **Natural Earth** 1:110m country boundaries, via the
`world-atlas` package (TopoJSON). Natural Earth is released into the **public
domain**; no attribution is legally required, and this notice records it as a
courtesy.
<https://www.naturalearthdata.com/about/terms-of-use/>

Natural Earth uses ISO 3166-1 numeric codes as country identifiers, which is why
`countries.iso_n3` in Trippy's schema is an integer rather than a string.

## Open-Meteo — weather

Forecast and historical weather on the trip page come from **Open-Meteo**
(`api.open-meteo.com`), which requires no API key and no attribution. See
<https://open-meteo.com/>.

## Google Fonts — typography

The two families (Archivo and IBM Plex Mono) are self-hosted WOFF2 subsets, both
under the **SIL Open Font License 1.1**.
See <https://scripts.sil.org/OFL>.

## Runtime libraries

React and React DOM (MIT) · Leaflet (BSD-2-Clause) · Hono (MIT) · Zod (MIT) ·
d3-geo, d3-array, d3-selection (ISC) · topojson-client (ISC) · world-atlas
(ISC, Natural Earth data as above).

## Not bundled

TREK's own `NOTICE.md` credits geoBoundaries, Wikimedia Commons, Google Places and
OurAirports. Trippy's Workers port ships none of those assets and calls none of
those services, so it neither bundles nor claims them. The credits are kept
upstream in <https://github.com/liketrek/TREK/blob/main/NOTICE.md>.
