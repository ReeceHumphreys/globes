import type { TileAddress } from "../tiles/resident-tiles.ts";

/**
 * Where the imagery cache gets tiles. It deals only in addresses, so published datasets and
 * live services are two adapters at the same seam.
 */
export interface ImagerySource {
  /** Core pixels across a tile, excluding its gutter. */
  readonly tileSize: number;
  /** Pixels of neighboring surface around each tile's core. */
  readonly gutter: number;
  /** The dataset level of the deepest tile. */
  maxLevel(): number;
  /** Whether a tile exists. */
  has(tile: TileAddress): boolean;
  /** A tile's RGBA pixels with its gutter, bottom row first. */
  load(tile: TileAddress, signal: AbortSignal): Promise<Uint8Array>;
  /** A line about what's available, for people. */
  describe(): string;
}

/** RGBA pixels of an image, top row first. */
export async function decodeImage(image: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
