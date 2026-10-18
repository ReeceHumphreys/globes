/** A time-dependent spacecraft position, already rotated into its central body's fixed frame. */
export interface OrbitEphemeris {
  /** Unique identifier: the NORAD catalog number for a TLE, OBJECT_ID for an OEM. */
  readonly id: string;
  readonly name: string;
  /** Central body name, compared case-insensitively with the globe body. */
  readonly center: string;
  /** UTC milliseconds covered by tabulated data; absent for analytic propagators. */
  readonly startMs?: number;
  readonly stopMs?: number;
  /** Approximate orbital period, used for default track lengths. */
  readonly periodSeconds?: number;
  /**
   * Writes the globe's scene coordinates in meters (+Y north, +X longitude 0) for UTC
   * milliseconds. Returns false, leaving `out` unspecified, when no position is available.
   */
  positionAt(timeMs: number, out: { [index: number]: number }): boolean;
  /** Central body gravitational parameter in m³/s², for osculating orbits. */
  readonly mu?: number;
  /**
   * Optional state relative to the center in a non-rotating frame, using the same axis
   * convention as the scene (meters, m/s). Enables inertial tracks and osculating orbits.
   */
  inertialStateAt?(
    timeMs: number,
    position: { [index: number]: number },
    velocity?: { [index: number]: number },
  ): boolean;
  /** Row-major rotation from that inertial frame to the body-fixed scene axes at `timeMs`. */
  inertialToFixed?(timeMs: number, out: { [index: number]: number }): boolean;
}

/** Standard gravitational parameter for a center name, when known. */
export function centerMu(center: string): number | undefined {
  return GM[center.trim().toUpperCase()];
}

/** Standard gravitational parameters (m³/s²) for periods derived from a state vector. */
const GM: Record<string, number> = {
  EARTH: 3.986004418e14,
  MOON: 4.9028e12,
  MARS: 4.282837e13,
};

/** Osculating two-body period, or undefined for an unknown center or an open orbit. */
export function osculatingPeriod(
  center: string,
  position: ArrayLike<number>,
  velocity: ArrayLike<number>,
): number | undefined {
  const mu = GM[center.trim().toUpperCase()];
  if (!mu) return undefined;
  const r = Math.hypot(position[0], position[1], position[2]);
  const v2 = velocity[0] ** 2 + velocity[1] ** 2 + velocity[2] ** 2;
  const energy = v2 / 2 - mu / r;
  if (!(energy < 0)) return undefined;
  const a = -mu / (2 * energy);
  return 2 * Math.PI * Math.sqrt((a * a * a) / mu);
}
