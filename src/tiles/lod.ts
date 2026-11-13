import { rootDirection } from "./roots.ts";

const elevations = new Float64Array(2);
const patch = new Float64Array(3);
const edge = new Float64Array(3);

/** Conservative min/max terrain height, in meters, over one quadtree tile. */
export interface HeightRanges {
  rangeForTile(root: number, level: number, x: number, y: number, out: Float64Array): void;
}

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

// Unit center, and the chord to the farthest point of the tile's edge. Differences of
// the unit vectors stay accurate when a deep tile's corners nearly coincide.
export function measurePatch(
  root: number,
  level: number,
  x: number,
  y: number,
  out: Float64Array,
): number {
  const n = 2 ** level;
  rootDirection(root, (x + 0.5) / n, (y + 0.5) / n, out);
  let chord = 0;
  // Corners and edge midpoints: a tile reaching a pole is widest along its edges.
  for (let j = 0; j <= 2; j++)
    for (let i = 0; i <= 2; i++) {
      if (i === 1 && j === 1) continue;
      rootDirection(root, (x + i / 2) / n, (y + j / 2) / n, edge);
      chord = Math.max(chord, Math.hypot(edge[0] - out[0], edge[1] - out[1], edge[2] - out[2]));
    }
  return chord;
}

// Approximate projected grid-cell size, not a measured elevation error.
// A spherical patch bound uses its center and four projected corners. Distance
// to its near edge concentrates refinement near the camera without culling.
export function projectedCellPixels(
  root: number,
  level: number,
  x: number,
  y: number,
  view: SelectionView,
  heights?: HeightRanges,
): number {
  const radius = view[VIEW.Radius];
  const chord = measurePatch(root, level, x, y, patch);
  let low = view[VIEW.MinElevation],
    high = view[VIEW.MaxElevation];
  if (heights) {
    heights.rangeForTile(root, level, x, y, elevations);
    low = elevations[0];
    high = elevations[1];
  }
  const centerRadius = radius + (low + high) / 2;
  const centerDistance = Math.hypot(
    view[VIEW.CameraX] - patch[0] * centerRadius,
    view[VIEW.CameraY] - patch[1] * centerRadius,
    view[VIEW.CameraZ] - patch[2] * centerRadius,
  );
  const patchRadius = (radius + high) * chord + (high - low) / 2;
  const nearDistance = Math.max(centerDistance - patchRadius, radius * 1e-6);
  return (
    (((2 * (radius + high) * chord) / view[VIEW.Segments]) * view[VIEW.ProjectionScale]) /
    nearDistance
  );
}
