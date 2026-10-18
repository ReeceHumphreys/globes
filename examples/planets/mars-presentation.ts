/** Illustrative viewing conditions, not retrieved weather or an ephemeris. */
export const MARS_DUST_PRESETS = {
  clear: { label: "Clearer · optical depth 0.2", opticalDepth: 0.2 },
  dusty: { label: "Dusty · optical depth 0.5", opticalDepth: 0.5 },
  thick: { label: "Very dusty · optical depth 1.5", opticalDepth: 1.5 },
} as const;
export type MarsDustPreset = keyof typeof MARS_DUST_PRESETS;
export function marsDustPreset(value: string | null): MarsDustPreset {
  return value && Object.hasOwn(MARS_DUST_PRESETS, value) ? (value as MarsDustPreset) : "clear";
}

// Compensate for weaker Mars sunlight, then add a small presentation lift.
// The energy used by terrain, atmospheric scattering and model lights is unchanged.
export const MARS_EXPOSURE_STOPS = Math.log2(1361 / 586.2) + 0.35;

// A raking Sun reveals terrain relief and puts a visible terminator on the disk.
// These are illustrative presentation settings, not an ephemeris.
export const MARS_SUN_OFFSET_DEG = 70;
export function marsSunForView(view: { longitude: number; latitude: number; sunOffset?: number }) {
  return {
    longitude: ((view.longitude + (view.sunOffset ?? 35) + 540) % 360) - 180,
    latitude: view.latitude > 80 ? 45 : 15,
  };
}

/** Approximate feature view centers, not surveyed landing-site coordinates. */
export const MARS_VIEWS = {
  orbit: {
    label: "Mars · dramatic orbit",
    latitude: 22,
    longitude: -65,
    altitude: 6_792_380,
    sunOffset: MARS_SUN_OFFSET_DEG,
  },
  valles: {
    label: "Valles Marineris · canyon",
    latitude: -13.9,
    longitude: -59.2,
    altitude: 450_000,
  },
  olympus: { label: "Olympus Mons", latitude: 18.65, longitude: -133.8, altitude: 700_000 },
  hellas: { label: "Hellas basin", latitude: -42.4, longitude: 70.5, altitude: 1_100_000 },
  north: { label: "North polar cap", latitude: 85, longitude: 0, altitude: 1_200_000 },
} as const;
