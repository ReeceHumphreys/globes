/**
 * Rotations from ICRF into a body-fixed frame, on the conventional body-fixed axes
 * (x longitude 0, y longitude 90° east, z north).
 * Times are UTC milliseconds since 1970. UT1 is taken as UTC, and TAI−UTC is fixed at 37 s
 * (correct since 2017), so absolute accuracy is visualization-grade: roughly a kilometer.
 */
type FrameTransform = (timeMs: number, vector: Float64Array) => void;

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const DAY_MS = 86_400_000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);
/** TT−UTC: 37 leap seconds plus TT−TAI. TDB is treated as TT. */
export const TT_MINUS_UTC_SECONDS = 69.184;

/** Passive rotation about z, as in Vallado's ROT3. */
function rotateZ(v: Float64Array, angle: number): void {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    x = v[0];
  v[0] = c * x + s * v[1];
  v[1] = -s * x + c * v[1];
}
function rotateY(v: Float64Array, angle: number): void {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    x = v[0];
  v[0] = c * x - s * v[2];
  v[2] = s * x + c * v[2];
}
function rotateX(v: Float64Array, angle: number): void {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    y = v[1];
  v[1] = c * y + s * v[2];
  v[2] = -s * y + c * v[2];
}

/** IAU-82 Greenwich mean sidereal time in radians. */
function greenwichMeanSiderealTime(timeMs: number): number {
  const t = (timeMs - J2000_MS) / (DAY_MS * 36525);
  const seconds =
    -6.2e-6 * t * t * t + 0.093104 * t * t + (876600 * 3600 + 8640184.812866) * t + 67310.54841;
  const angle = ((seconds * DEG) / 240) % (2 * Math.PI);
  return angle < 0 ? angle + 2 * Math.PI : angle;
}

// IAU-76 precession into the mean equator of date, then mean sidereal rotation.
// Nutation (up to ~17″) and polar motion are omitted.
const j2000ToEarthFixed: FrameTransform = (timeMs, v) => {
  const t = (timeMs + TT_MINUS_UTC_SECONDS * 1000 - J2000_MS) / (DAY_MS * 36525);
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * ARCSEC;
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * ARCSEC;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * ARCSEC;
  rotateZ(v, -zeta);
  rotateY(v, theta);
  rotateZ(v, -z);
  rotateZ(v, greenwichMeanSiderealTime(timeMs));
};

/** IAU WGCCRE orientation: pole right ascension/declination and prime meridian, in degrees. */
type Orientation = (days: number, centuries: number) => [number, number, number];

function iauFixed(orientation: Orientation): FrameTransform {
  return (timeMs, v) => {
    const days = (timeMs + TT_MINUS_UTC_SECONDS * 1000 - J2000_MS) / DAY_MS;
    const [alpha, delta, w] = orientation(days, days / 36525);
    rotateZ(v, (90 + alpha) * DEG);
    rotateX(v, (90 - delta) * DEG);
    rotateZ(v, (w % 360) * DEG);
  };
}

// Archinal et al. (2011), the 2009 IAU report. It approximates the mean-Earth frame.
const moon: Orientation = (d, T) => {
  const sin = (deg: number) => Math.sin(deg * DEG),
    cos = (deg: number) => Math.cos(deg * DEG);
  const E1 = 125.045 - 0.0529921 * d,
    E2 = 250.089 - 0.1059842 * d,
    E3 = 260.008 + 13.0120009 * d,
    E4 = 176.625 + 13.3407154 * d,
    E5 = 357.529 + 0.9856003 * d,
    E6 = 311.589 + 26.4057084 * d,
    E7 = 134.963 + 13.064993 * d,
    E8 = 276.617 + 0.3287146 * d,
    E9 = 34.226 + 1.7484877 * d,
    E10 = 15.134 - 0.1589763 * d,
    E11 = 119.743 + 0.0036096 * d,
    E12 = 239.961 + 0.1643573 * d,
    E13 = 25.053 + 12.9590088 * d;
  return [
    269.9949 +
      0.0031 * T -
      3.8787 * sin(E1) -
      0.1204 * sin(E2) +
      0.07 * sin(E3) -
      0.0172 * sin(E4) +
      0.0072 * sin(E6) -
      0.0052 * sin(E10) +
      0.0043 * sin(E13),
    66.5392 +
      0.013 * T +
      1.5419 * cos(E1) +
      0.0239 * cos(E2) -
      0.0278 * cos(E3) +
      0.0068 * cos(E4) -
      0.0029 * cos(E6) +
      0.0009 * cos(E7) +
      0.0008 * cos(E10) -
      0.0009 * cos(E13),
    38.3213 +
      13.17635815 * d -
      1.4e-12 * d * d +
      3.561 * sin(E1) +
      0.1208 * sin(E2) -
      0.0642 * sin(E3) +
      0.0158 * sin(E4) +
      0.0252 * sin(E5) -
      0.0066 * sin(E6) -
      0.0047 * sin(E7) -
      0.0046 * sin(E8) +
      0.0028 * sin(E9) +
      0.0052 * sin(E10) +
      0.004 * sin(E11) +
      0.0019 * sin(E12) -
      0.0044 * sin(E13),
  ];
};
const mars: Orientation = (d, T) => [
  317.68143 - 0.1061 * T,
  52.8865 - 0.0609 * T,
  176.63 + 350.89198226 * d,
];

const ICRF_TO_FIXED: Record<string, FrameTransform> = {
  EARTH: j2000ToEarthFixed,
  MOON: iauFixed(moon),
  MARS: iauFixed(mars),
};

/** ICRF to body-fixed axes for Earth, the Moon or Mars. */
export function icrfToBodyFixed(center: string): FrameTransform {
  const transform = ICRF_TO_FIXED[center.trim().toUpperCase()];
  if (!transform) throw new Error(`No body-fixed frame for ${center}`);
  return transform;
}
