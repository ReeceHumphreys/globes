import type { HeightRanges } from "../elevation/ranges.ts";
import { tileVisible } from "./visibility.ts";
import { FACE_COUNT } from "./roots.ts";
import { assertTileBatch, type TileBatch } from "./tile.ts";
import { VIEW, VIEW_LENGTH, projectedCellPixels, type SelectionView } from "./lod.ts";

// Child q is bottom-left, bottom-right, top-left, top-right: (x*2 + q&1, y*2 + q>>1).
function forEachChild(
  face: number,
  level: number,
  x: number,
  y: number,
  visit: (face: number, level: number, x: number, y: number) => void,
): void {
  for (let q = 0; q < 4; q++) visit(face, level + 1, x * 2 + (q & 1), y * 2 + (q >> 1));
}

export function selectTiles(output: TileBatch, targetLevel: number): void {
  assertTileBatch(output);
  if (!Number.isInteger(targetLevel) || targetLevel < 0 || targetLevel > 30) {
    throw new RangeError("Tile level must be an integer between 0 and 30.");
  }
  const required = FACE_COUNT * 4 ** targetLevel;
  // Check before writing so errors leave the previous selection intact.
  if (required > output.capacity) {
    throw new RangeError(`Selection needs ${required} tiles; capacity is ${output.capacity}.`);
  }
  let count = 0;
  function visit(face: number, level: number, x: number, y: number): void {
    if (level === targetLevel) {
      output.face[count] = face;
      output.level[count] = level;
      output.x[count] = x;
      output.y[count] = y;
      count++;
      return;
    }
    forEachChild(face, level, x, y, visit);
  }
  for (let face = 0; face < FACE_COUNT; face++) visit(face, 0, 0, 0);
  output.count = count;
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
  if (output.capacity < FACE_COUNT) {
    throw new RangeError("Tile capacity must accommodate all six roots.");
  }
  // Count before writing. If the requested detail exceeds the fixed budget,
  // relax the pixel target globally and retry, preserving coverage and symmetry.
  let pixelTarget = view[VIEW.MaxCellPixels];
  function countLeaves(face: number, level: number, x: number, y: number): number {
    if (!tileVisible(face, level, x, y, view, heights)) return 0;
    if (level === maxLevel || projectedCellPixels(face, level, x, y, view, heights) <= pixelTarget)
      return 1;
    let leaves = 0;
    // Same child order as forEachChild. Stop once the fixed budget is already exceeded.
    for (let q = 0; q < 4; q++) {
      leaves += countLeaves(face, level + 1, x * 2 + (q & 1), y * 2 + (q >> 1));
      if (leaves > output.capacity) break;
    }
    return leaves;
  }
  while (true) {
    let required = 0;
    for (let face = 0; face < FACE_COUNT && required <= output.capacity; face++) {
      required += countLeaves(face, 0, 0, 0);
    }
    if (required <= output.capacity) break;
    pixelTarget *= 2;
  }
  let count = 0;
  function visit(face: number, level: number, x: number, y: number): void {
    if (!tileVisible(face, level, x, y, view, heights)) return;
    const split =
      level < maxLevel && projectedCellPixels(face, level, x, y, view, heights) > pixelTarget;
    if (!split) {
      output.face[count] = face;
      output.level[count] = level;
      output.x[count] = x;
      output.y[count] = y;
      count++;
      return;
    }
    forEachChild(face, level, x, y, visit);
  }
  for (let face = 0; face < FACE_COUNT; face++) visit(face, 0, 0, 0);
  output.count = count;
}
