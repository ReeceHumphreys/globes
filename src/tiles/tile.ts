import type { SelectionView } from "./lod.ts";

// Columns are face, level, x, y. Each is capacity uint32s.
export interface TileBatch {
  readonly buffer: ArrayBuffer;
  readonly capacity: number;
  count: number;
  readonly face: Uint32Array;
  readonly level: Uint32Array;
  readonly x: Uint32Array;
  readonly y: Uint32Array;
}

export const TILE_BYTES = 16;

export function assertTileBatch(batch: TileBatch): void {
  if (
    !Number.isInteger(batch.count) ||
    batch.count < 0 ||
    batch.count > batch.capacity ||
    batch.face.length !== batch.capacity ||
    batch.level.length !== batch.capacity ||
    batch.x.length !== batch.capacity ||
    batch.y.length !== batch.capacity
  ) {
    throw new RangeError("Invalid tile batch.");
  }
}

export function createTileBatch(capacity: number): TileBatch {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("Buffer capacity must be a positive integer.");
  }
  const buffer = new ArrayBuffer(capacity * TILE_BYTES);
  const stride = capacity * Uint32Array.BYTES_PER_ELEMENT;
  return {
    buffer,
    capacity,
    count: 0,
    face: new Uint32Array(buffer, 0, capacity),
    level: new Uint32Array(buffer, stride, capacity),
    x: new Uint32Array(buffer, 2 * stride, capacity),
    y: new Uint32Array(buffer, 3 * stride, capacity),
  };
}

// Selectors write into caller-owned columns, then set output.count.
export type AdaptiveTileSelector = (output: TileBatch, view: SelectionView) => void;
