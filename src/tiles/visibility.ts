import { heightRangeForTile, type HeightRanges } from "../elevation/ranges.ts";
import { measurePatch, VIEW, type SelectionView } from "./lod.ts";
import { faceToWorld } from "./roots.ts";

const elevations = new Float64Array(2);
const local = new Float64Array(3);
const direction = new Float64Array(3);
export function tileVisible(
  face: number,
  level: number,
  x: number,
  y: number,
  view: SelectionView,
  heights?: HeightRanges,
): boolean {
  if (!view[VIEW.Cull]) return true;
  const n = 2 ** level;
  const chord = measurePatch(level, x, y, local);
  faceToWorld(face, local[0], local[1], local[2], direction);
  const r = view[VIEW.Radius];
  const cx = view[0],
    cy = view[1],
    cz = view[2],
    distance = Math.hypot(cx, cy, cz);
  let low = view[VIEW.MinElevation],
    high = view[VIEW.MaxElevation];
  if (heights) {
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
  // Only the globally inscribed sphere is a safe terrain occluder. A peak may
  // remain visible beyond the reference-sphere horizon.
  const inner = r + view[VIEW.MinElevation],
    outer = r + high;
  if (distance > inner) {
    const horizon =
      Math.acos(Math.min(1, inner / distance)) + Math.acos(Math.min(1, inner / outer));
    if (
      (cx * direction[0] + cy * direction[1] + cz * direction[2]) / distance + chord <
      Math.cos(horizon)
    )
      return false;
  }
  const centerRadius = r + (low + high) / 2;
  const bx = direction[0] * centerRadius - cx,
    by = direction[1] * centerRadius - cy,
    bz = direction[2] * centerRadius - cz;
  // Planes are camera-relative, computed in double precision on the CPU.
  // Include the inward skirts in frustum bounds.
  const skirt = Math.max(0.02, (4 * (r / n) ** 2) / (r * view[VIEW.Segments] ** 2));
  const sphereRadius = chord * (r + high) + (high - low) / 2 + skirt;
  for (let p = VIEW.Planes; p < VIEW.Planes + 24; p += 4) {
    if (view[p] * bx + view[p + 1] * by + view[p + 2] * bz + view[p + 3] < -sphereRadius)
      return false;
  }
  return true;
}
