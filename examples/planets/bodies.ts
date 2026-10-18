/** Dataset radii must match the generated manifests, rather than a nominal average. */
export const BODIES = {
  moon: { name: "Moon", radiusMeters: 1737400, imagery: "data/moon/wac/manifest.json" },
  earth: {
    name: "Earth",
    radiusMeters: 6378137,
    imagery: "data/earth/s2cloudless-2020-z7/manifest.json",
    elevation: "data/earth/elevation-tiles/manifest.json",
    // NASA Black Marble 2016, resampled to 8192×4096. https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/
    nightLights: "data/earth/night-lights/black-marble-2016.jpg",
    regions: "data/earth/sites/catalog.json",
  },
  mars: {
    name: "Mars",
    radiusMeters: 3396190,
    imagery: "data/mars/viking/manifest.json",
    elevation: "data/mars/elevation-tiles/manifest.json",
  },
} as const;
/** Same centers as tile-service datasets/earth-sites.json. The 2 km disks are the launch pads. */
export const EARTH_SITES = {
  starbase: { label: "Starbase", latitudeDeg: 25.997, longitudeDeg: -97.157 },
  ksc: { label: "Kennedy Space Center", latitudeDeg: 28.608389, longitudeDeg: -80.604333 },
} as const;

export type BodyId = keyof typeof BODIES;
export function bodyId(value: string | null): BodyId {
  return value && Object.hasOwn(BODIES, value) ? (value as BodyId) : "moon";
}
