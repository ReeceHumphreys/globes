import { tileVisible } from "./visibility.ts";
import { ROOT_COUNT } from "./roots.ts";
import { assertTileBatch, type TileBatch } from "./tile.ts";
import {
  VIEW,
  VIEW_LENGTH,
  projectedCellPixels,
  type HeightRanges,
  type SelectionView,
} from "./lod.ts";

// Child q is bottom-left, bottom-right, top-left, top-right: (x*2 + q&1, y*2 + q>>1).
function forEachChild(
  root: number,
  level: number,
  x: number,
  y: number,
  visit: (root: number, level: number, x: number, y: number) => void,
): void {
  for (let q = 0; q < 4; q++) visit(root, level + 1, x * 2 + (q & 1), y * 2 + (q >> 1));
}

// Adaptive traversal retains coarse leaves where grid cells are already small
// enough on screen. Optional horizon/frustum culling rejects invisible branches before splitting.
export function selectAdaptiveTiles(
  output: TileBatch,
  view: SelectionView,
  heights?: HeightRanges,
): void {
  assertTileBatch(output);
  if (
    view.length !== VIEW_LENGTH ||
    !view.every(Number.isFinite) ||
    view[VIEW.MinElevation] > view[VIEW.MaxElevation] ||
    view[VIEW.Radius] + view[VIEW.MinElevation] <= 0 ||
    view[VIEW.Radius] <= 0 ||
    view[VIEW.ProjectionScale] <= 0 ||
    !Number.isInteger(view[VIEW.Segments]) ||
    view[VIEW.Segments] < 1 ||
    view[VIEW.MaxCellPixels] <= 0 ||
    !Number.isInteger(view[VIEW.MaxLevel]) ||
    (view[VIEW.Cull] !== 0 && view[VIEW.Cull] !== 1) ||
    view[VIEW.MaxLevel] < 0 ||
    view[VIEW.MaxLevel] > 30
  ) {
    throw new RangeError("Invalid adaptive selection view.");
  }
  const maxLevel = view[VIEW.MaxLevel];
  if (output.capacity < ROOT_COUNT) {
    throw new RangeError("Tile capacity must accommodate every root.");
  }
  // Count before writing. If the requested detail exceeds the fixed budget,
  // relax the pixel target globally and retry, preserving coverage and symmetry.
  let pixelTarget = view[VIEW.MaxCellPixels];
  function countLeaves(root: number, level: number, x: number, y: number): number {
    if (!tileVisible(root, level, x, y, view, heights)) return 0;
    if (level === maxLevel || projectedCellPixels(root, level, x, y, view, heights) <= pixelTarget)
      return 1;
    let leaves = 0;
    // Same child order as forEachChild. Stop once the fixed budget is already exceeded.
    for (let q = 0; q < 4; q++) {
      leaves += countLeaves(root, level + 1, x * 2 + (q & 1), y * 2 + (q >> 1));
      if (leaves > output.capacity) break;
    }
    return leaves;
  }
  while (true) {
    let required = 0;
    for (let root = 0; root < ROOT_COUNT && required <= output.capacity; root++) {
      required += countLeaves(root, 0, 0, 0);
    }
    if (required <= output.capacity) break;
    pixelTarget *= 2;
  }
  let count = 0;
  function visit(root: number, level: number, x: number, y: number): void {
    if (!tileVisible(root, level, x, y, view, heights)) return;
    const split =
      level < maxLevel && projectedCellPixels(root, level, x, y, view, heights) > pixelTarget;
    if (!split) {
      output.root[count] = root;
      output.level[count] = level;
      output.x[count] = x;
      output.y[count] = y;
      count++;
      return;
    }
    forEachChild(root, level, x, y, visit);
  }
  for (let root = 0; root < ROOT_COUNT; root++) visit(root, 0, 0, 0);
  output.count = count;
}
