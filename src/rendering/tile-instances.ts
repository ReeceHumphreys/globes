import { Color } from "three/webgpu";
import { assertTileBatch, type TileBatch } from "../tiles/tile.ts";
import { rootDirection, rootWidth } from "../tiles/roots.ts";
import { tileColor } from "./tile-colors.ts";

// One buffer, in attribute order: size, color, anchor, root UV, root. origin is the camera
// position and is not uploaded. Sizes are meters across at the equator or the pole. A root UV
// is the tile's u, v and width on its root.
export interface TileInstances {
  readonly buffer: ArrayBuffer;
  readonly capacity: number;
  count: number;
  revision: number;
  readonly sizes: Float32Array;
  readonly colors: Float32Array;
  readonly anchors: Float32Array;
  readonly rootUVs: Float32Array;
  readonly roots: Float32Array;
  readonly origin: Float64Array;
}
export const INSTANCE_BYTES = 44;

/** Level of a drawn instance, from its width on its root. */
export const instanceLevel = (instances: TileInstances, i: number) =>
  Math.round(-Math.log2(instances.rootUVs[i * 3 + 2]));

/** Tile address of a drawn instance. */
export const instanceAddress = (instances: TileInstances, i: number) => {
  const j = i * 3,
    size = instances.rootUVs[j + 2];
  return {
    root: instances.roots[i],
    level: instanceLevel(instances, i),
    x: Math.round(instances.rootUVs[j] / size),
    y: Math.round(instances.rootUVs[j + 1] / size),
  };
};

/** Center of a drawn instance on its root. */
export const instanceCenter = (instances: TileInstances, i: number): [number, number] => {
  const j = i * 3,
    half = instances.rootUVs[j + 2] / 2;
  return [instances.rootUVs[j] + half, instances.rootUVs[j + 1] + half];
};

export function assertTileInstances(data: TileInstances): void {
  if (
    !Number.isInteger(data.count) ||
    data.count < 0 ||
    data.count > data.capacity ||
    data.roots.length !== data.capacity ||
    data.rootUVs.length !== data.capacity * 3 ||
    data.anchors.length !== data.capacity * 3 ||
    data.origin.length !== 3 ||
    data.sizes.length !== data.capacity ||
    data.colors.length !== data.capacity * 3
  ) {
    throw new RangeError("Invalid tile instances.");
  }
}

export function createTileInstances(capacity: number): TileInstances {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("Buffer capacity must be a positive integer.");
  }
  const buffer = new ArrayBuffer(capacity * INSTANCE_BYTES);
  const stride = capacity * Float32Array.BYTES_PER_ELEMENT;
  return {
    buffer,
    capacity,
    count: 0,
    revision: 0,
    sizes: new Float32Array(buffer, 0, capacity),
    colors: new Float32Array(buffer, stride, capacity * 3),
    anchors: new Float32Array(buffer, 4 * stride, capacity * 3),
    rootUVs: new Float32Array(buffer, 7 * stride, capacity * 3),
    roots: new Float32Array(buffer, 10 * stride, capacity),
    origin: new Float64Array(3),
  };
}

const color = new Color();
const center = new Float64Array(3);

// Pack addresses into the GPU columns. Selection stays in the tile batch.
export function writeTileInstances(
  tiles: TileBatch,
  output: TileInstances,
  radius: number,
  originX = 0,
  originY = 0,
  originZ = 0,
): void {
  assertTileBatch(tiles);
  assertTileInstances(output);
  if (tiles.count > output.capacity) {
    throw new RangeError(`Instance capacity is ${output.capacity}; received ${tiles.count} tiles.`);
  }
  output.origin[0] = originX;
  output.origin[1] = originY;
  output.origin[2] = originZ;
  for (let i = 0; i < tiles.count; i++) {
    const root = tiles.root[i];
    output.roots[i] = root;
    const level = tiles.level[i];
    const x = tiles.x[i];
    const y = tiles.y[i];
    const uvScale = 1 / 2 ** level;
    const u = (x + 0.5) * uvScale,
      v = (y + 0.5) * uvScale;
    output.rootUVs[i * 3] = x * uvScale;
    output.rootUVs[i * 3 + 1] = y * uvScale;
    output.rootUVs[i * 3 + 2] = uvScale;
    output.sizes[i] = uvScale * radius * rootWidth(root);
    rootDirection(root, u, v, center);
    output.anchors[i * 3] = center[0] * radius - originX;
    output.anchors[i * 3 + 1] = center[1] * radius - originY;
    output.anchors[i * 3 + 2] = center[2] * radius - originZ;
    color.setHex(tileColor(root, level, x, y));
    output.colors[i * 3] = color.r;
    output.colors[i * 3 + 1] = color.g;
    output.colors[i * 3 + 2] = color.b;
  }
  output.count = tiles.count;
  output.revision++;
}
