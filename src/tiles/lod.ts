import { heightRangeForTile, type HeightRanges } from "../elevation/ranges.ts";
import { faceToWorld, worldToFace } from "./roots.ts";

const elevations = new Float64Array(2);
const patch = new Float64Array(3);
const cameraOnFace = new Float64Array(3);
const direction = new Float64Array(3);

// 35 float64 values. ProjectionScale = viewportHeight / (2 * tan(verticalFov / 2)).
export const VIEW = {
  CameraX: 0,
  CameraY: 1,
  CameraZ: 2,
  Radius: 3,
  ProjectionScale: 4,
  Segments: 5,
  MaxCellPixels: 6,
  MaxLevel: 7,
  Cull: 8,
  Planes: 9,
  MinElevation: 33,
  MaxElevation: 34,
} as const;
export type SelectionView = Float64Array;
export const VIEW_LENGTH = 35;

export function createSelectionView(): SelectionView {
  return new Float64Array(VIEW_LENGTH);
}

// Face-local unit center, and the chord to the farthest corner. Differences of
// the unit vectors stay accurate when a deep tile's corners nearly coincide.
export function measurePatch(level: number, x: number, y: number, out: Float64Array): number {
  const n = 2 ** level;
  const u = (x + 0.5) / n - 0.5;
  const v = (y + 0.5) / n - 0.5;
  const inv = 1 / Math.hypot(u, v, 0.5);
  const a = (out[0] = u * inv);
  const b = (out[1] = v * inv);
  const c = (out[2] = 0.5 * inv);
  let chord = 0;
  for (let q = 0; q < 4; q++) {
    const cu = (x + (q & 1)) / n - 0.5,
      cv = (y + (q >> 1)) / n - 0.5;
    const cl = Math.hypot(cu, cv, 0.5);
    chord = Math.max(chord, Math.hypot(cu / cl - a, cv / cl - b, 0.5 / cl - c));
  }
  return chord;
}

// Approximate projected grid-cell size, not a measured elevation error.
// A spherical patch bound uses its center and four projected corners. Distance
// to its near edge concentrates refinement near the camera without culling.
export function projectedCellPixels(
  face: number,
  level: number,
  x: number,
  y: number,
  view: SelectionView,
  heights?: HeightRanges,
): number {
  const radius = view[VIEW.Radius];
  const chord = measurePatch(level, x, y, patch);
  // Sphere distances are unchanged by the face rotation, so compare in the patch frame.
  worldToFace(face, view[VIEW.CameraX], view[VIEW.CameraY], view[VIEW.CameraZ], cameraOnFace);
  let low = view[VIEW.MinElevation],
    high = view[VIEW.MaxElevation];
  if (heights) {
    faceToWorld(face, patch[0], patch[1], patch[2], direction);
    heightRangeForTile(
      heights,
      face,
      level,
      x,
      y,
      direction[0],
      direction[1],
      direction[2],
      chord,
      elevations,
    );
    low = elevations[0];
    high = elevations[1];
  }
  const centerRadius = radius + (low + high) / 2;
  const centerDistance = Math.hypot(
    cameraOnFace[0] - patch[0] * centerRadius,
    cameraOnFace[1] - patch[1] * centerRadius,
    cameraOnFace[2] - patch[2] * centerRadius,
  );
  const patchRadius = (radius + high) * chord + (high - low) / 2;
  const nearDistance = Math.max(centerDistance - patchRadius, radius * 1e-6);
  return (
    (((2 * (radius + high) * chord) / view[VIEW.Segments]) * view[VIEW.ProjectionScale]) /
    nearDistance
  );
}
