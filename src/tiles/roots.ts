// The grid: four roots, each its own quadtree over u and v from 0 to 1, y up. Roots 0 and 1
// are the western and eastern hemispheres in plain latitude and longitude. Roots 2 and 3 are
// north and south polar caps, in stereographic projection of the surface normal, so the
// poles get square tiles. Both grids draw between the join latitudes; see root-join.wgsl.
// The dataset contract defines the grid. tests/contract holds its reference values.
export const ROOT_COUNT = 4;
export const ROOT_WEST = 0;
export const ROOT_EAST = 1;
export const ROOT_NORTH = 2;
export const ROOT_SOUTH = 3;

/** Half the width of a cap, in tan(colatitude / 2). Edges reach 78.8°, corners 74.2°. */
export const CAP_HALF = Math.PI / 32;
/** A cap tile matches the ground size of a geographic tile this many levels deeper. */
const CAP_LEVEL_OFFSET = 3;
/** The contract's deepest level. */
export const MAX_LEVEL = 20;
const JOIN_START = (80 * Math.PI) / 180;
const JOIN_END = (81 * Math.PI) / 180;
const JOIN_MIDDLE = (JOIN_START + JOIN_END) / 2;
const SIN_JOIN_MIDDLE = Math.sin(JOIN_MIDDLE);

export const isCap = (root: number) => root >= ROOT_NORTH;

export const tileKey = (root: number, level: number, x: number, y: number) =>
  `${root}/${level}/${x}/${y}`;

/** Root, level, x and y of a tile address, or undefined if it isn't a valid one. */
export function parseTileKey(key: unknown): [number, number, number, number] | undefined {
  if (typeof key !== "string" || !/^[0-3]\/\d+\/\d+\/\d+$/.test(key)) return undefined;
  const [root, level, x, y] = key.split("/").map(Number);
  if (tileKey(root, level, x, y) !== key || x >= 2 ** level || y >= 2 ** level) return undefined;
  return [root, level, x, y];
}

// Two kinds of level: a tile's address has a root level, and a dataset's maxLevel is a dataset
// level, the level on the geographic roots. These three functions are the only conversions.

/** A dataset level as a level of `root`. Negative where a cap has nothing that coarse. */
export const rootLevel = (root: number, level: number) =>
  isCap(root) ? level - CAP_LEVEL_OFFSET : level;

/** The dataset level of a tile at `level` of `root`. */
export const datasetLevel = (root: number, level: number) =>
  isCap(root) ? level + CAP_LEVEL_OFFSET : level;

/** The deepest level of a root, for a dataset reaching `maxLevel`. */
export const rootMaxLevel = (root: number, maxLevel: number) =>
  Math.max(0, rootLevel(root, maxLevel));

/** Radians of surface across a root, at the equator or the pole. */
export const rootWidth = (root: number) => (isCap(root) ? 4 * CAP_HALF : Math.PI);

const SHADER_CONSTANTS: Record<string, string> = {
  CAP_HALF: CAP_HALF.toFixed(8),
  SIN_JOIN_START: Math.sin(JOIN_START).toFixed(8),
  SIN_JOIN_MIDDLE: SIN_JOIN_MIDDLE.toFixed(8),
  SIN_JOIN_END: Math.sin(JOIN_END).toFixed(8),
  // Shaders carry a root as a float, so they compare it halfway between roots.
  CAP_ROOT_START: (ROOT_NORTH - 0.5).toFixed(1),
  SOUTH_ROOT_START: (ROOT_SOUTH - 0.5).toFixed(1),
  MAX_LEVEL: String(MAX_LEVEL),
};
const SHADER_NAMES = new RegExp(`\\b(${Object.keys(SHADER_CONSTANTS).join("|")})\\b`, "g");

/** WGSL source with the grid's constants filled in, so the shaders hold no copy of them. */
export const gridShader = (code: string) =>
  code.replace(SHADER_NAMES, (name) => SHADER_CONSTANTS[name]);

/** Unit surface normal at a root's u and v. Values outside 0..1 extrapolate. */
export function rootDirection(
  root: number,
  u: number,
  v: number,
  out: Float64Array,
  offset = 0,
): void {
  if (isCap(root)) {
    const x = (2 * u - 1) * CAP_HALF,
      y = (2 * v - 1) * CAP_HALF;
    const s = 1 + x * x + y * y;
    const north = root === ROOT_NORTH;
    out[offset] = ((north ? -2 : 2) * y) / s;
    out[offset + 1] = (north ? 1 : -1) * (2 / s - 1);
    out[offset + 2] = (-2 * x) / s;
    return;
  }
  const longitude = (u + (root === ROOT_WEST ? -1 : 0)) * Math.PI;
  const latitude = (v - 0.5) * Math.PI;
  out[offset] = Math.cos(latitude) * Math.cos(longitude);
  out[offset + 1] = Math.sin(latitude);
  out[offset + 2] = -Math.cos(latitude) * Math.sin(longitude);
}

/** The u and v of a direction on a chosen root, extrapolating past its edges. */
export function rootUV(root: number, x: number, y: number, z: number): [number, number] {
  const length = Math.hypot(x, y, z);
  x /= length;
  y /= length;
  z /= length;
  if (root === ROOT_NORTH)
    return [(-z / (1 + y) / CAP_HALF + 1) / 2, (-x / (1 + y) / CAP_HALF + 1) / 2];
  if (root === ROOT_SOUTH)
    return [(-z / (1 - y) / CAP_HALF + 1) / 2, (x / (1 - y) / CAP_HALF + 1) / 2];
  const longitude = Math.atan2(-z, x);
  return [
    longitude / Math.PI + (root === ROOT_WEST ? 1 : 0),
    Math.atan2(y, Math.hypot(x, z)) / Math.PI + 0.5,
  ];
}

/** The root that owns a nonzero direction, and its u and v. root-point.wgsl matches it. */
export function rootPoint(x: number, y: number, z: number): [number, number, number] {
  const sine = y / Math.hypot(x, y, z);
  const root =
    sine > SIN_JOIN_MIDDLE
      ? ROOT_NORTH
      : sine < -SIN_JOIN_MIDDLE
        ? ROOT_SOUTH
        : Math.atan2(-z, x) < 0
          ? ROOT_WEST
          : ROOT_EAST;
  const [u, v] = rootUV(root, x, y, z);
  return [root, Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))];
}

const CAP_REACH = Math.tan((Math.PI / 2 - JOIN_START) / 2);

/** Whether a tile reaches the part of the surface its root draws. */
export function tileInUse(root: number, level: number, x: number, y: number): boolean {
  const n = 2 ** level;
  if (isCap(root)) {
    const nearest = (low: number, high: number) => {
      const a = (2 * low - 1) * CAP_HALF,
        b = (2 * high - 1) * CAP_HALF;
      return a <= 0 && b >= 0 ? 0 : Math.min(Math.abs(a), Math.abs(b));
    };
    return (
      Math.hypot(nearest(x / n, (x + 1) / n), nearest(y / n, (y + 1) / n)) <= CAP_REACH * 1.001
    );
  }
  const south = (y / n - 0.5) * Math.PI,
    north = ((y + 1) / n - 0.5) * Math.PI;
  return south < JOIN_END && north > -JOIN_END;
}
