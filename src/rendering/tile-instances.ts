import { Color } from "three/webgpu";
import { assertTileBatch, type TileBatch } from "../tiles/tile.ts";
import { FACE_ROTATION_X, FACE_ROTATION_Y, faceToWorld } from "../tiles/roots.ts";
import { tileColor } from "./tile-colors.ts";

// One buffer, in attribute order: size, rotation, center, color, anchor, face UV, face id.
// origin is the camera position and is not uploaded.
export interface TileInstances {
  readonly buffer: ArrayBuffer;
  readonly capacity: number;
  count: number;
  revision: number;
  readonly sizes: Float32Array;
  readonly rotations: Float32Array;
  readonly centers: Float32Array;
  readonly colors: Float32Array;
  readonly anchors: Float32Array;
  readonly faceUVs: Float32Array;
  readonly faces: Float32Array;
  readonly origin: Float64Array;
}
export const INSTANCE_BYTES = 72;

export function assertTileInstances(data: TileInstances): void {
  if (
    !Number.isInteger(data.count) ||
    data.count < 0 ||
    data.count > data.capacity ||
    data.faces.length !== data.capacity ||
    data.faceUVs.length !== data.capacity * 4 ||
    data.anchors.length !== data.capacity * 3 ||
    data.origin.length !== 3 ||
    data.sizes.length !== data.capacity * 2 ||
    data.rotations.length !== data.capacity * 2 ||
    data.centers.length !== data.capacity * 3 ||
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
    sizes: new Float32Array(buffer, 0, capacity * 2),
    rotations: new Float32Array(buffer, 2 * stride, capacity * 2),
    centers: new Float32Array(buffer, 4 * stride, capacity * 3),
    colors: new Float32Array(buffer, 7 * stride, capacity * 3),
    anchors: new Float32Array(buffer, 10 * stride, capacity * 3),
    faceUVs: new Float32Array(buffer, 13 * stride, capacity * 4),
    faces: new Float32Array(buffer, 17 * stride, capacity),
    origin: new Float64Array(3),
  };
}

const color = new Color();
const center = new Float64Array(3);

// Pack addresses into the GPU columns. Selection stays in the tile batch.
export function writeTileInstances(
  tiles: TileBatch,
  output: TileInstances,
  sideLength: number,
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
  const half = sideLength / 2;
  for (let i = 0; i < tiles.count; i++) {
    const face = tiles.face[i];
    output.faces[i] = face;
    const level = tiles.level[i];
    const x = tiles.x[i];
    const y = tiles.y[i];
    const uvScale = 1 / 2 ** level;
    output.faceUVs[i * 4] = x * uvScale;
    output.faceUVs[i * 4 + 1] = y * uvScale;
    output.faceUVs[i * 4 + 2] = uvScale;
    output.faceUVs[i * 4 + 3] = uvScale;
    const size = sideLength * uvScale;
    const u = (x + 0.5) * size - half;
    const v = (y + 0.5) * size - half;
    output.sizes[i * 2] = size;
    output.sizes[i * 2 + 1] = size;
    output.rotations[i * 2] = FACE_ROTATION_X[face];
    output.rotations[i * 2 + 1] = FACE_ROTATION_Y[face];
    faceToWorld(face, u, v, half, center);
    const cx = center[0],
      cy = center[1],
      cz = center[2];
    output.centers[i * 3] = cx;
    output.centers[i * 3 + 1] = cy;
    output.centers[i * 3 + 2] = cz;
    const scale = sideLength / Math.hypot(cx, cy, cz);
    output.anchors[i * 3] = cx * scale - originX;
    output.anchors[i * 3 + 1] = cy * scale - originY;
    output.anchors[i * 3 + 2] = cz * scale - originZ;
    color.setHex(tileColor(face, level, x, y));
    output.colors[i * 3] = color.r;
    output.colors[i * 3 + 1] = color.g;
    output.colors[i * 3 + 2] = color.b;
  }
  output.count = tiles.count;
  output.revision++;
}
