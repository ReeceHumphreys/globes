import type { TileInstances } from "../rendering/tile-instances.ts";
import { worldToFace } from "../tiles/roots.ts";

export interface StreamingView {
  // Projection × camera rotation only: anchors already subtract camera origin.
  clipFromRelative: ArrayLike<number>;
  projectionScale: number;
  now: number;
}
export function screenImportance(
  instances: TileInstances,
  i: number,
  view?: StreamingView,
): number {
  if (!view) return 1;
  const m = view.clipFromRelative,
    j = i * 3,
    x = instances.anchors[j],
    y = instances.anchors[j + 1],
    z = instances.anchors[j + 2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (w <= 0) return 0.001;
  const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  const sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  const span = (instances.sizes[i * 2] * view.projectionScale) / Math.max(1, Math.hypot(x, y, z));
  const centrality = 1 / (1 + sx * sx + sy * sy);
  return Math.max(0.001, Math.min(1e12, span * span)) * (0.25 + 0.75 * centrality);
}
const local = new Float64Array(3);
// Face-local sub-camera coordinates, used only to predict speculative requests.
export function cameraFaceUV(face: number, x: number, y: number, z: number): [number, number] {
  worldToFace(face, x, y, z, local);
  const u = local[0],
    v = local[1],
    w = local[2];
  return w > 0 ? [(u / w) * 0.5 + 0.5, (v / w) * 0.5 + 0.5] : [0.5, 0.5];
}
