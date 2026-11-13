import type { TileAddress } from "../tiles/resident-tiles.ts";
import type { HeightEncoding } from "./tiles.ts";

/** Height bounds of one tile, in meters. */
export interface HeightBounds {
  /** Lowest and highest sample of this tile. */
  min: number;
  max: number;
  /** Bounds of this tile and every tile below it. */
  lower: number;
  upper: number;
  /** Finer tiles exist below this one but are not listed yet. */
  partial?: boolean;
}

/**
 * Where the height cache gets tiles: uint16 values on the tile contract's grid, with
 * meters = value · scaleMeters + offsetMeters. A published dataset is one adapter; any
 * other terrain format can be another. Addresses use the contract's roots and levels.
 */
export interface HeightSource extends HeightEncoding {
  /** Core samples across a tile, excluding its gutter. 16 to 256. */
  readonly tileSize: number;
  /** Samples of neighboring surface around each tile's core. 2 to 8. */
  readonly gutter: number;
  /** The dataset level of the deepest tile. */
  readonly maxLevel: number;
  /** Lowest and highest height anywhere, in meters. */
  readonly minMeters: number;
  readonly maxMeters: number;
  /** What height 0 is, such as "ellipsoid", "sphere" or "areoid". */
  readonly verticalDatum: string;
  /** A tile's bounds, or undefined where there is no tile or it is not listed yet. Every root has one. */
  bounds(tile: TileAddress): HeightBounds | undefined;
  /** A tile's values with its gutter, top row (v = 1) first, inside its `bounds`. */
  load(tile: TileAddress, signal: AbortSignal): Promise<Uint16Array>;
  /**
   * For sources that list fine tiles lazily. Called on every update with the tiles in
   * view and the deepest tile under the camera. Call `changed` when the listing changes.
   */
  focus?(tiles: readonly TileAddress[], changed: () => void): void;
  /** Listings in flight. The view is not loaded until this is 0. */
  pending?(): number;
  /** Stop work. The globe calls it when it no longer needs the source. */
  dispose?(): void;
}
