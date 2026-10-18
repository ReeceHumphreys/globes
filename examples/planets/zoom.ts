/** Scroll zoom for the orrery. Scroll in eases the focus toward a body, then moves closer. */

const ZOOM_PER_PIXEL = 0.001;

export const PRELOAD_RADII = 2000;
export const CANCEL_RADII = 8000;
export const HANDOFF_RADII = 8;
export const CLOSE_RADII = 3.2;
/** Farther than the handoff, so arriving at eight radii does not immediately leave. */
export const LEAVE_RADII = HANDOFF_RADII + 0.25;

export type Departure = { x: number; y: number; z: number; timeMs: number };

export type Arrival = {
  x: number;
  y: number;
  z: number;
  timeMs: number;
  distanceMeters: number;
};

/** The globe is built hidden, then shown from the live camera once it is ready. */
export type HeldStart = {
  hold: true;
  ready: (reveal: (arrival: Arrival) => void) => void;
};

export function isHeld(value: object | undefined): value is HeldStart {
  return !!value && "hold" in value;
}

/** Keep the detailed view inside the globe camera's working range. */
export function handoffDistance(radiusMeters: number, distanceMeters: number): number {
  return Math.min(
    radiusMeters * HANDOFF_RADII,
    Math.max(radiusMeters * CLOSE_RADII, distanceMeters),
  );
}

/**
 * Camera stays put while the focus eases toward `target` (zoom in only).
 * Positive `deltaY` moves out. yaw 0 pitch 0 leaves the camera on +Z of the focus.
 */
export function zoomToward(
  camera: ArrayLike<number>,
  focus: ArrayLike<number>,
  target: ArrayLike<number> | null,
  deltaY: number,
  min: number,
  max: number,
): { focus: Float64Array; yaw: number; pitch: number; distance: number } {
  const next = new Float64Array([focus[0] ?? 0, focus[1] ?? 0, focus[2] ?? 0]);
  if (target && deltaY < 0) {
    next[0] += ((target[0] ?? 0) - next[0]) * 0.45;
    next[1] += ((target[1] ?? 0) - next[1]) * 0.45;
    next[2] += ((target[2] ?? 0) - next[2]) * 0.45;
  }
  const dx = (camera[0] ?? 0) - next[0];
  const dy = (camera[1] ?? 0) - next[1];
  const dz = (camera[2] ?? 0) - next[2];
  const span = Math.hypot(dx, dy, dz) || min;
  return {
    focus: next,
    yaw: Math.atan2(dx, dz),
    pitch: Math.asin(Math.min(1, Math.max(-1, dy / span))),
    distance: Math.min(max, Math.max(min, span * Math.exp(deltaY * ZOOM_PER_PIXEL))),
  };
}
