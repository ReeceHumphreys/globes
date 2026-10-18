import { createTileBatch, type AdaptiveTileSelector, type TileBatch } from "./tiles/tile.ts";
import { selectAdaptiveTiles } from "./tiles/quadtree.ts";
import { VIEW, type SelectionView } from "./tiles/lod.ts";
import {
  createTileInstances,
  writeTileInstances,
  type TileInstances,
} from "./rendering/tile-instances.ts";

// Reuses address batches and one instance buffer. Repacks when the selected
// tiles, radius, or camera origin change.
export type TileProducer = (view: SelectionView) => TileInstances;

export function createTileProducer(
  capacity: number,
  select: AdaptiveTileSelector = selectAdaptiveTiles,
): TileProducer {
  let previous = createTileBatch(capacity);
  let scratch = createTileBatch(capacity);
  const instances = createTileInstances(capacity);
  let previousRadius = NaN;

  function sameSelection(a: TileBatch, b: TileBatch): boolean {
    if (a.count !== b.count) return false;
    for (let i = 0; i < a.count; i++) {
      if (
        a.face[i] !== b.face[i] ||
        a.level[i] !== b.level[i] ||
        a.x[i] !== b.x[i] ||
        a.y[i] !== b.y[i]
      )
        return false;
    }
    return true;
  }

  return (view) => {
    select(scratch, view);
    const radius = view[VIEW.Radius];
    if (
      instances.origin[0] !== view[0] ||
      instances.origin[1] !== view[1] ||
      instances.origin[2] !== view[2] ||
      radius !== previousRadius ||
      !sameSelection(scratch, previous)
    ) {
      writeTileInstances(scratch, instances, radius, view[0], view[1], view[2]);
      const swap = previous;
      previous = scratch;
      scratch = swap;
      previousRadius = radius;
    }
    return instances;
  };
}
