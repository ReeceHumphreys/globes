// Bundled 2K overviews: the viewer works without tile-service. See assets/overviews.
import earthOverviewURL from "./assets/overviews/earth-2k.jpg";
import usaCoastlineURL from "./assets/coastlines/usa.geojson?url";
import marsOverviewURL from "./assets/overviews/mars-2k.jpg";
import moonOverviewURL from "./assets/overviews/moon-2k.jpg";

/** Dataset radii must match the generated manifests, rather than a nominal average. */
export const BODIES = {
  earth: {
    name: "Earth",
    radiusMeters: 6378137,
    // WGS84. Imagery and heights are geodetic, so they sit on it unchanged.
    flattening: 1 / 298.257223563,
    exposureStops: 0.5,
    overview: earthOverviewURL,
    // Required by the image's CC BY-NC-SA license; the panel shows it. See assets/overviews.
    credit:
      "Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020), CC BY-NC-SA 4.0. Clouds: NASA Goddard Space Flight Center, Reto Stöckli",
    imagery: "data/earth/s2cloudless-2020-z7/manifest.json",
    elevation: "data/earth/elevation-tiles/manifest.json",
    // NASA Black Marble 2016, resampled to 8192×4096. https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/
    nightLights: "data/earth/night-lights/black-marble-2016.jpg",
    // NASA Blue Marble clouds, one fixed day. See public/data/earth/clouds.
    clouds: "data/earth/clouds/blue-marble-clouds-8k.jpg",
    regions: "data/earth/sites/catalog.json",
    // Natural Earth, without land borders. See assets/coastlines.
    coastline: usaCoastlineURL,
  },
  moon: {
    name: "Moon",
    radiusMeters: 1737400,
    exposureStops: 2,
    overview: moonOverviewURL,
    imagery: "data/moon/wac/manifest.json",
    elevation: "data/moon/elevation-tiles/manifest.json",
    regions: "data/moon/apollo/catalog.json",
  },
  mars: {
    name: "Mars",
    radiusMeters: 3396190,
    exposureStops: 2,
    overview: marsOverviewURL,
    imagery: "data/mars/viking/manifest.json",
    elevation: "data/mars/elevation-tiles/manifest.json",
  },
} as const;

export type BodyId = keyof typeof BODIES;
export const BODY_IDS = Object.keys(BODIES) as BodyId[];

export function bodyId(value: string | null): BodyId {
  return value && Object.hasOwn(BODIES, value) ? (value as BodyId) : "earth";
}

/** Same centers as tile-service datasets/earth-sites.json. The 2 km disks are the launch pads. */
export const EARTH_SITES = [
  { label: "Starbase", latitudeDeg: 25.997, longitudeDeg: -97.157 },
  { label: "Kennedy Space Center", latitudeDeg: 28.608389, longitudeDeg: -80.604333 },
] as const;
