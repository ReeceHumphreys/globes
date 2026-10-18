import { resolveFrame, TT_MINUS_UTC_SECONDS } from "./frames.ts";

const DEG = Math.PI / 180;
const OBLIQUITY_J2000 = 23.43928 * DEG;

/** JPL approximate elements (Standish, 1800–2050): a, e, I, L, ϖ, Ω and rates per century. */
type Elements = readonly [number, number, number, number, number, number];
const EARTH_MOON_BARYCENTER: [Elements, Elements] = [
  [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0],
  [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
];
const MARS: [Elements, Elements] = [
  [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
  [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
];

const AU_METERS = 149_597_870_700;

function centuriesSinceJ2000(timeMs: number): number {
  return (timeMs + TT_MINUS_UTC_SECONDS * 1000 - Date.UTC(2000, 0, 1, 12)) / (86_400_000 * 36525);
}

/** Heliocentric position in AU, ICRF axes. */
function heliocentric([base, rate]: [Elements, Elements], centuries: number): Float64Array {
  const [a, e, I, L, perihelion, node] = base.map((value, i) => value + rate[i] * centuries);
  const M = ((((L - perihelion) % 360) + 540) % 360) - 180;
  let E = M * DEG + e * Math.sin(M * DEG);
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M * DEG) / (1 - e * Math.cos(E));
  const x = a * (Math.cos(E) - e),
    y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const w = (perihelion - node) * DEG,
    o = node * DEG,
    i = I * DEG;
  const cw = Math.cos(w),
    sw = Math.sin(w),
    co = Math.cos(o),
    so = Math.sin(o),
    ci = Math.cos(i),
    si = Math.sin(i);
  const ex = (cw * co - sw * so * ci) * x + (-sw * co - cw * so * ci) * y;
  const ey = (cw * so + sw * co * ci) * x + (-sw * so + cw * co * ci) * y;
  const ez = sw * si * x + cw * si * y;
  const ce = Math.cos(OBLIQUITY_J2000),
    se = Math.sin(OBLIQUITY_J2000);
  return new Float64Array([ex, ce * ey - se * ez, se * ey + ce * ez]);
}

/** Earth is the Earth–Moon barycenter. ICRF meters. */
export function heliocentricMeters(
  body: "earth" | "mars",
  timeMs: number,
  out: Float64Array,
): void {
  const au = heliocentric(
    body === "mars" ? MARS : EARTH_MOON_BARYCENTER,
    centuriesSinceJ2000(timeMs),
  );
  out[0] = au[0] * AU_METERS;
  out[1] = au[1] * AU_METERS;
  out[2] = au[2] * AU_METERS;
}

/**
 * Planetocentric latitude and east longitude where the Sun is overhead, for the globe's
 * `setSun`. Accurate to about 0.01° for Earth and Mars; the Moon uses the Earth–Moon
 * barycenter, which adds up to 0.15° of parallax.
 */
export function subsolarPoint(
  center: string,
  timeMs: number,
): { longitudeDeg: number; latitudeDeg: number } {
  const body = center.trim().toUpperCase();
  const orbit =
    body === "MARS"
      ? MARS
      : body === "EARTH" || body === "MOON"
        ? EARTH_MOON_BARYCENTER
        : undefined;
  if (!orbit) throw new Error(`No solar ephemeris for ${center}`);
  const sun = heliocentric(orbit, centuriesSinceJ2000(timeMs));
  sun[0] = -sun[0];
  sun[1] = -sun[1];
  sun[2] = -sun[2];
  resolveFrame(center, "ICRF")(timeMs, sun);
  const length = Math.hypot(sun[0], sun[1], sun[2]);
  return {
    longitudeDeg: Math.atan2(sun[1], sun[0]) / DEG,
    latitudeDeg: Math.asin(sun[2] / length) / DEG,
  };
}
