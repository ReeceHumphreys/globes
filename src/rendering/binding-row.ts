import type { TilePair } from "../tiles/resident-tiles.ts";
import type { TileInstances } from "./tile-instances.ts";

// Each drawn tile's row in the instance buffer. Imagery and heights both begin with a
// tile pair; heights add the face and height range; one packed cache flag ends the row.
export const PAIR = { layers: 0, best: 2, parent: 6, blend: 10 } as const;
const PAIR_FLOATS = 11;
export const IMAGERY_STRIDE = PAIR_FLOATS;
export const HEIGHT_FACE = PAIR_FLOATS;
/** Also the length of what a baked sunlight patch depends on: the row before the range. */
export const HEIGHT_RANGE = PAIR_FLOATS + 1;
export const HEIGHT_STRIDE = HEIGHT_RANGE + 1;
export const ROW_HEIGHT = IMAGERY_STRIDE;
export const ROW_FLAGS = IMAGERY_STRIDE + HEIGHT_STRIDE;
export const ROW_STRIDE = ROW_FLAGS + 1;

// The packed flag is a sunlight slot + 1, plus this bit once a tile's gradients are baked.
// cache-flags.wgsl reads it.
export const GRADIENT_READY_BIT = 256;
export const MAX_SUNLIGHT_SLOTS = GRADIENT_READY_BIT - 1;

/** How a tile's own 0..1 square sits in its texture layer. */
export interface TileTexels {
  scale: number;
  offset: number;
  /** Rows run bottom-up. */
  flipV?: boolean;
}

type PairedTile = { level: number; x: number; y: number; slot: number };

function writeUV(
  data: Float32Array,
  at: number,
  tile: PairedTile | undefined,
  instances: TileInstances,
  i: number,
  { scale, offset, flipV = false }: TileTexels,
) {
  if (!tile) {
    data.fill(0, at, at + 4);
    return;
  }
  const n = 2 ** tile.level,
    j = i * 4,
    v = instances.faceUVs[j + 1] * n - tile.y;
  data[at] = offset + (instances.faceUVs[j] * n - tile.x) * scale;
  data[at + 1] = offset + (flipV ? 1 - v : v) * scale;
  data[at + 2] = instances.faceUVs[j + 2] * n * scale;
  data[at + 3] = instances.faceUVs[j + 3] * n * scale * (flipV ? -1 : 1);
}

/** Write instance i's tile pair at `at`: slots, where each sits in its layer, and the blend. */
export function writeTilePair(
  data: Float32Array,
  at: number,
  { best, parent, blend }: TilePair<PairedTile>,
  instances: TileInstances,
  i: number,
  texels: TileTexels,
): void {
  data[at + PAIR.layers] = best?.slot ?? 0;
  data[at + PAIR.layers + 1] = parent?.slot ?? 0;
  writeUV(data, at + PAIR.best, best, instances, i, texels);
  writeUV(data, at + PAIR.parent, parent, instances, i, texels);
  data[at + PAIR.blend] = blend;
}
