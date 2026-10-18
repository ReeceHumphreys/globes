import { resolveFrame, toScene } from "./frames.ts";
import { heliocentricMeters } from "./sun-position.ts";

const DEG = Math.PI / 180;
const DAY_MS = 86_400_000;
const EARTH_RADIUS_M = 6_378_137;
const OBLIQUITY = 23.43928 * DEG;
// 2000 Jan 0.0 UT, the day count used by Schlyter's lunar elements.
const SCHLYTER_EPOCH_MS = Date.UTC(1999, 11, 31);
// Mean-longitude rates: Earth and Mars match the L rates in sun-position.ts.
const PERIOD_MS = {
  earth: (360 * 36525 * DAY_MS) / 35999.37244981,
  mars: (360 * 36525 * DAY_MS) / 19140.30268499,
  moon: (360 * DAY_MS) / (13.0649929509 + 0.1643573223 - 0.0529538083),
};

export type SolarBody = "sun" | "earth" | "moon" | "mars";

/**
 * Heliocentric position in the globe scene (+Y celestial north, −Z is 90° east), meters.
 * Earth is the Earth–Moon barycenter. The Moon is Schlyter's short series, about a degree,
 * equinox of date.
 * shortcut: Earth is not shifted off the barycenter (~4700 km). Upgrade if a sky Moon needs that.
 */
export function sceneSolarPosition(body: SolarBody, timeMs: number, out: Float64Array): void {
  if (body === "sun") {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  if (body === "moon") {
    sceneSolarPosition("earth", timeMs, out);
    const geo = new Float64Array(3);
    moonGeocentricIcrf(timeMs, geo);
    toScene(geo, geo);
    out[0] += geo[0];
    out[1] += geo[1];
    out[2] += geo[2];
    return;
  }
  if (body !== "earth" && body !== "mars") throw new Error(`No solar position for ${body}`);
  const icrf = new Float64Array(3);
  heliocentricMeters(body, timeMs, icrf);
  toScene(icrf, out);
}

/** Closed orbit in scene meters. The Moon's samples are geocentric. The last point repeats the first. */
export function sceneOrbit(
  body: "earth" | "mars" | "moon",
  timeMs: number,
  count: number,
): Float64Array {
  if (!Number.isInteger(count) || count < 3) throw new RangeError("Orbit needs at least 3 samples");
  const out = new Float64Array((count + 1) * 3);
  const sample = new Float64Array(3);
  const period = PERIOD_MS[body];
  for (let i = 0; i <= count; i++) {
    const t = timeMs + (period * i) / count;
    if (body === "moon") {
      moonGeocentricIcrf(t, sample);
      toScene(sample, sample);
    } else sceneSolarPosition(body, t, sample);
    out[i * 3] = sample[0];
    out[i * 3 + 1] = sample[1];
    out[i * 3 + 2] = sample[2];
  }
  // Perigee moves, so a sidereal month does not land exactly on the start. Join it.
  const end = count * 3;
  out[end] = out[0];
  out[end + 1] = out[1];
  out[end + 2] = out[2];
  return out;
}

/**
 * Drawn radius. A distant body stays at least `minAngularRadius` wide; the true radius
 * takes over once you are close enough that it already looks larger.
 */
export function shownRadius(
  radiusMeters: number,
  distanceMeters: number,
  minAngularRadius = 0.35 * DEG,
): number {
  return Math.max(radiusMeters, Math.abs(distanceMeters) * Math.tan(minAngularRadius));
}

/**
 * Camera offset from the focus, scene axes. yaw 0 pitch 0 is +Z, positive yaw moves
 * toward +X, positive pitch toward +Y.
 */
export function orbitOffset(yaw: number, pitch: number, distance: number, out: Float64Array): void {
  const cp = Math.cos(pitch);
  out[0] = distance * cp * Math.sin(yaw);
  out[1] = distance * Math.sin(pitch);
  out[2] = distance * cp * Math.cos(yaw);
}

/** Inertial scene offset (body → camera) written in that body's fixed scene axes. */
export function bodySceneOffset(
  center: "earth" | "moon" | "mars",
  timeMs: number,
  sceneOffset: ArrayLike<number>,
  out: Float64Array,
): void {
  const icrf = new Float64Array([sceneOffset[0] ?? 0, -(sceneOffset[2] ?? 0), sceneOffset[1] ?? 0]);
  resolveFrame(center, "ICRF")(timeMs, icrf);
  toScene(icrf, out);
}

/** Inverse of bodySceneOffset. Body-fixed scene offset back to the inertial scene. */
export function sceneBodyOffset(
  center: "earth" | "moon" | "mars",
  timeMs: number,
  fixedScene: ArrayLike<number>,
  out: Float64Array,
): void {
  const axis = new Float64Array(3);
  const column = new Float64Array(3);
  const x = fixedScene[0] ?? 0;
  const y = fixedScene[1] ?? 0;
  const z = fixedScene[2] ?? 0;
  for (let i = 0; i < 3; i++) {
    axis[0] = axis[1] = axis[2] = 0;
    axis[i] = 1;
    bodySceneOffset(center, timeMs, axis, column);
    // Columns of the forward map. The inverse of a rotation is its transpose.
    out[i] = column[0] * x + column[1] * y + column[2] * z;
  }
}

/** Geocentric ICRF meters. Schlyter, with the listed lunar perturbations. */
function moonGeocentricIcrf(timeMs: number, out: Float64Array): void {
  const d = (timeMs - SCHLYTER_EPOCH_MS) / DAY_MS;
  const N = (125.1228 - 0.0529538083 * d) * DEG;
  const i = 5.1454 * DEG;
  const w = (318.0634 + 0.1643573223 * d) * DEG;
  const a = 60.2666;
  const e = 0.0549;
  const M = (115.3654 + 13.0649929509 * d) * DEG;
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  let r = Math.hypot(xv, yv);
  const vw = v + w;
  const cv = Math.cos(vw);
  const sv = Math.sin(vw);
  const xh = r * (Math.cos(N) * cv - Math.sin(N) * sv * Math.cos(i));
  const yh = r * (Math.sin(N) * cv + Math.cos(N) * sv * Math.cos(i));
  const zh = r * sv * Math.sin(i);
  const Ms = (356.047 + 0.9856002585 * d) * DEG;
  const Ls = Ms + (282.9404 + 4.70935e-5 * d) * DEG;
  const Lm = M + w + N;
  const D = Lm - Ls;
  const F = Lm - N;
  let lon = Math.atan2(yh, xh);
  let lat = Math.atan2(zh, Math.hypot(xh, yh));
  const sin = Math.sin;
  lon +=
    DEG *
    (-1.274 * sin(M - 2 * D) +
      0.658 * sin(2 * D) -
      0.186 * sin(Ms) -
      0.059 * sin(2 * M - 2 * D) -
      0.057 * sin(M - 2 * D + Ms) +
      0.053 * sin(M + 2 * D) +
      0.046 * sin(2 * D - Ms) +
      0.041 * sin(M - Ms) -
      0.035 * sin(D) -
      0.031 * sin(M + Ms) -
      0.015 * sin(2 * F - 2 * D) +
      0.011 * sin(M - 4 * D));
  lat +=
    DEG *
    (-0.173 * sin(F - 2 * D) -
      0.055 * sin(M - F - 2 * D) -
      0.046 * sin(M + F - 2 * D) +
      0.033 * sin(F + 2 * D) +
      0.017 * sin(2 * M + F));
  r += -0.58 * Math.cos(M - 2 * D) - 0.46 * Math.cos(2 * D);
  const x = r * Math.cos(lat) * Math.cos(lon);
  const y = r * Math.cos(lat) * Math.sin(lon);
  const z = r * Math.sin(lat);
  const ce = Math.cos(OBLIQUITY);
  const se = Math.sin(OBLIQUITY);
  out[0] = x * EARTH_RADIUS_M;
  out[1] = (ce * y - se * z) * EARTH_RADIUS_M;
  out[2] = (se * y + ce * z) * EARTH_RADIUS_M;
}
