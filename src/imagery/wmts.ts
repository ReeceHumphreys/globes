import {
  datasetLevel,
  ROOT_COUNT,
  ROOT_NORTH,
  ROOT_SOUTH,
  rootDirection,
  rootWidth,
} from "../tiles/roots.ts";
import { decodeImage, type ImagerySource } from "./source.ts";
import type { TileAddress } from "../tiles/resident-tiles.ts";

/** One tiled image source, as a WMTS or XYZ service publishes it. */
export interface WmtsLayer {
  /** Tile URL with `{z}`, `{row}` and `{col}`, the service's own numbering. */
  url: string;
  /** Deepest level the service has. */
  maxLevel: number;
  /** Pixels across a tile. Defaults to 256. */
  tileSize?: number;
  /** How the service's grid maps to the body. Defaults to two 180° tiles at level 0. */
  grid?: WmtsGrid;
}

/** How a tile service lays its tiles over the body. */
export type WmtsGrid =
  /** Latitude and longitude from the north-west corner; 180 is the usual level 0 tile. */
  | {
      /** Discriminates the grid. */
      type: "geographic";
      /** Degrees across a level 0 tile. */
      tileDegrees: number;
    }
  /** Web Mercator, one tile at level 0. Stops about 5° short of each pole. */
  | {
      /** Discriminates the grid. */
      type: "mercator";
    }
  /** Polar stereographic, as NASA GIBS's EPSG:3031 and EPSG:3413. */
  | {
      /** Discriminates the grid. */
      type: "polar";
      /** +1 north, -1 south. */
      pole: 1 | -1;
      /** Projected units from the pole to the grid's edge. */
      halfWidth: number;
      /** Tiles across at level 0. */
      rootTiles: number;
      /** Semi-major axis, in the grid's units. */
      semiMajorAxis: number;
      /** Of the ellipsoid; 0 is a sphere. */
      eccentricity: number;
      /** Latitude of true scale, degrees from the equator. 90 is the pole. */
      trueScaleDegrees: number;
      /** The longitude straight below the pole on the grid. */
      centralMeridianDegrees: number;
    };

/**
 * Imagery straight from a tile service, with no preparation. `north` and `south` serve the
 * polar caps; without them `globe` is sampled there too, smeared as lat-long maps are.
 * Services must allow cross-origin requests, and their usage terms apply.
 *
 * @example
 * NASA GIBS. Its level 0 tiles span 288°, so its geographic grid says so.
 * ```ts
 * const layer = "BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/500m/{z}/{row}/{col}.jpeg";
 * new TiledGlobe({
 *   radius: 6_378_137,
 *   flattening: 1 / 298.257223563,
 *   imagery: {
 *     globe: {
 *       url: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${layer}`,
 *       maxLevel: 7,
 *       tileSize: 512,
 *       grid: { type: "geographic", tileDegrees: 288 },
 *     },
 *   },
 * });
 * ```
 */
export interface WmtsImagery {
  /** The whole body. */
  globe: WmtsLayer;
  /** The north polar cap. */
  north?: WmtsLayer;
  /** The south polar cap. */
  south?: WmtsLayer;
}

/** Where a latitude and longitude fall, in fractions of a level 0 tile from the grid's origin. */
export function gridPosition(
  grid: WmtsGrid,
  latitude: number,
  longitude: number,
): [number, number] {
  if (grid.type === "geographic")
    return [(longitude + 180) / grid.tileDegrees, (90 - latitude) / grid.tileDegrees];
  if (grid.type === "mercator") {
    const y = Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
    return [(longitude + 180) / 360, 0.5 - y / (2 * Math.PI)];
  }
  const { pole, semiMajorAxis: a, eccentricity: e, halfWidth } = grid;
  const conformal = (phi: number) => {
    const sin = Math.sin(phi);
    return Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * sin) / (1 + e * sin)) ** (e / 2);
  };
  const phiC = (grid.trueScaleDegrees * Math.PI) / 180;
  const sinC = Math.sin(phiC);
  const t = conformal((pole * latitude * Math.PI) / 180);
  const rho =
    grid.trueScaleDegrees === 90
      ? (2 * a * t) / Math.sqrt((1 + e) ** (1 + e) * (1 - e) ** (1 - e))
      : (a * (Math.cos(phiC) / Math.sqrt(1 - e * e * sinC * sinC)) * t) / conformal(phiC);
  const lambda = ((longitude - grid.centralMeridianDegrees) * Math.PI) / 180;
  const x = rho * Math.sin(lambda),
    y = -pole * rho * Math.cos(lambda);
  const tile = (2 * halfWidth) / grid.rootTiles;
  return [(x + halfWidth) / tile, (halfWidth - y) / tile];
}

const DEFAULT_GRID: WmtsGrid = { type: "geographic", tileDegrees: 180 };
const TILE_SIZE = 256;
const GUTTER = 2;
const IMAGE = TILE_SIZE + 2 * GUTTER;

/** The layer that serves a root. */
const layerFor = (imagery: WmtsImagery, root: number) =>
  (root === ROOT_NORTH ? imagery.north : root === ROOT_SOUTH ? imagery.south : undefined) ??
  imagery.globe;

/** Radians of surface across a level 0 tile of a grid. */
function gridTileRadians(grid: WmtsGrid): number {
  if (grid.type === "geographic") return (grid.tileDegrees * Math.PI) / 180;
  if (grid.type === "mercator") return 2 * Math.PI;
  return (2 * grid.halfWidth) / grid.rootTiles / grid.semiMajorAxis;
}

/** How many levels a layer's level runs ahead of the root level with the same pixel size. */
function levelsAhead(root: number, { grid = DEFAULT_GRID, tileSize = TILE_SIZE }: WmtsLayer) {
  return Math.log2((gridTileRadians(grid) * TILE_SIZE) / (rootWidth(root) * tileSize));
}

/** The deepest level of a root worth drawing, from whichever layer serves that root. */
export function wmtsRootMaxLevel(imagery: WmtsImagery, root: number): number {
  const layer = layerFor(imagery, root);
  return Math.max(0, Math.ceil(layer.maxLevel - levelsAhead(root, layer)));
}

/** RGBA pixels of one source tile, or undefined where the service has none. */
export type WmtsTileReader = (
  url: string,
  signal: AbortSignal,
) => Promise<{ data: Uint8ClampedArray; width: number; height: number } | undefined>;

async function readTile(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (response.status === 400 || response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Tile: HTTP ${response.status}: ${url}`);
  return decodeImage(await response.blob());
}

const SOURCE_TILES_KEPT = 96;
// One download per URL. A caller's abort must not cancel a neighbor still using it.
const sharedDownload = new AbortController().signal;
const direction = new Float64Array(3);

/**
 * Imagery from a live service: builds each of our tiles by sampling the service's tiles at
 * every pixel, so any of its grids can feed ours.
 */
export function createWmtsImagery(
  imagery: WmtsImagery,
  read: WmtsTileReader = readTile,
): ImagerySource {
  const tiles = new Map<string, ReturnType<WmtsTileReader>>();
  const fetchTile = (url: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    let tile = tiles.get(url);
    if (tile) {
      // Oldest first, so a hit moves to the back.
      tiles.delete(url);
    } else {
      const shared = read(url, sharedDownload);
      shared.catch(() => {
        if (tiles.get(url) === shared) tiles.delete(url);
      });
      tile = shared;
    }
    tiles.set(url, tile);
    if (tiles.size > SOURCE_TILES_KEPT) tiles.delete(tiles.keys().next().value!);
    return tile.then((pixels) => {
      signal.throwIfAborted();
      return pixels;
    });
  };

  async function load(
    { root, level, x, y }: TileAddress,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const source = layerFor(imagery, root);
    const grid = source.grid ?? DEFAULT_GRID;

    const positions = new Float64Array(IMAGE * IMAGE * 2);
    const n = 2 ** level;
    for (let row = 0; row < IMAGE; row++)
      for (let col = 0; col < IMAGE; col++) {
        const u = (x + (col + 0.5 - GUTTER) / TILE_SIZE) / n,
          v = (y + (row + 0.5 - GUTTER) / TILE_SIZE) / n;
        rootDirection(root, u, v, direction);
        const latitude = (Math.asin(Math.max(-1, Math.min(1, direction[1]))) * 180) / Math.PI;
        const longitude = (Math.atan2(-direction[2], direction[0]) * 180) / Math.PI;
        const [gx, gy] = gridPosition(grid, latitude, longitude);
        const i = (row * IMAGE + col) * 2;
        positions[i] = gx;
        positions[i + 1] = gy;
      }
    const wanted = Math.ceil(level + levelsAhead(root, source));
    const z = Math.max(0, Math.min(source.maxLevel, wanted));
    const scale = 2 ** z;

    const needed = new Map<string, [number, number]>();
    for (let i = 0; i < positions.length; i += 2) {
      const col = Math.floor(positions[i] * scale),
        row = Math.floor(positions[i + 1] * scale);
      needed.set(`${col}/${row}`, [col, row]);
    }
    const loaded = new Map<string, Awaited<ReturnType<WmtsTileReader>>>();
    await Promise.all(
      [...needed].map(async ([key, [col, row]]) => {
        if (col < 0 || row < 0) return;
        const address = source.url
          .replace("{z}", String(z))
          .replace("{row}", String(row))
          .replace("{col}", String(col));
        loaded.set(key, await fetchTile(address, signal));
      }),
    );

    // Row 0 of the result is the image's bottom, as the tile cache's decoder leaves it.
    // shortcut: nearest-neighbor sampling, upgrade to bilinear if live imagery looks blocky.
    const pixels = new Uint8Array(IMAGE * IMAGE * 4);
    for (let row = 0; row < IMAGE; row++)
      for (let col = 0; col < IMAGE; col++) {
        const i = (row * IMAGE + col) * 2;
        const fx = positions[i] * scale,
          fy = positions[i + 1] * scale;
        const tileCol = Math.floor(fx),
          tileRow = Math.floor(fy);
        const tile = loaded.get(`${tileCol}/${tileRow}`);
        if (!tile) continue;
        const px = Math.min(tile.width - 1, Math.floor((fx - tileCol) * tile.width)),
          py = Math.min(tile.height - 1, Math.floor((fy - tileRow) * tile.height));
        const from = (py * tile.width + px) * 4,
          to = (row * IMAGE + col) * 4;
        pixels[to] = tile.data[from];
        pixels[to + 1] = tile.data[from + 1];
        pixels[to + 2] = tile.data[from + 2];
        pixels[to + 3] = tile.data[from + 3];
      }
    return pixels;
  }

  const levels = Array.from({ length: ROOT_COUNT }, (_, root) => wmtsRootMaxLevel(imagery, root));
  const deepest = Math.max(...levels.map((level, root) => datasetLevel(root, level)));
  return {
    tileSize: TILE_SIZE,
    gutter: GUTTER,
    maxLevel: () => deepest,
    has: ({ root, level }) => level <= levels[root],
    load,
    describe: () => `Live imagery to level ${deepest}`,
  };
}
