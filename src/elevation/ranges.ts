import { heightBoundsForCap, type HeightBounds } from "./bounds.ts";
export interface TileHeightRanges {
  rangeForTile(face: number, level: number, x: number, y: number, out: Float64Array): void;
}
export type HeightRanges = HeightBounds | TileHeightRanges;
export function heightRangeForTile(
  source: HeightRanges,
  face: number,
  level: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  dz: number,
  chord: number,
  out: Float64Array,
): void {
  if ("rangeForTile" in source) source.rangeForTile(face, level, x, y, out);
  else heightBoundsForCap(source, dx, dy, dz, chord, out);
}
