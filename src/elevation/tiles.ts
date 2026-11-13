import { relativePath, validateTileStorage, type PMTilesStorage } from "../tiles/tile-source.ts";
import { matchesBody, type GlobeBody } from "../body.ts";
import { MAX_LEVEL, parseTileKey, ROOT_COUNT, rootMaxLevel, tileKey } from "../tiles/roots.ts";
/** How stored uint16 heights map to meters: value * scaleMeters + offsetMeters. */
export interface HeightEncoding {
  scaleMeters: number;
  offsetMeters: number;
}
const TILE_PATH = relativePath("u16");
const PAGE_PATH = relativePath("json");

/** Meters from a stored uint16 height. decode-height.wgsl matches it. */
export const heightMeters = (value: number, encoding: HeightEncoding) =>
  value * encoding.scaleMeters + encoding.offsetMeters;

/** The stored bytes nearest zero meters, little-endian. */
export function zeroHeightBytes(encoding: HeightEncoding): [number, number] {
  const stored = Math.round(-encoding.offsetMeters / encoding.scaleMeters);
  const value = Math.max(0, Math.min(65535, stored));
  return [value & 255, value >> 8];
}
export interface HeightTileInfo {
  path: string;
  min: number;
  max: number;
  lower: number;
  upper: number;
  sha256: string;
}
export interface HeightTileManifest {
  storage?: PMTilesStorage;
  version: 2;
  body: string;
  radiusMeters: number;
  projection: "geographic-polar";
  format: "uint16-le";
  scaleMeters: number;
  offsetMeters: number;
  /** What heights are measured from, such as "ellipsoid", "sphere" or "areoid". */
  verticalDatum: string;
  tileSize: number;
  gutter: number;
  maxLevel: number;
  minMeters: number;
  maxMeters: number;
  tiles: Record<string, HeightTileInfo>;
  pageLevel?: number;
  pages?: Record<string, { path: string; sha256: string; lower: number; upper: number }>;
  sources: { id: string; credit: string; sourcePage: string }[];
}
const validSource = (s: unknown) => {
  const source = s as Record<string, unknown> | null;
  return (
    !!source &&
    typeof source.id === "string" &&
    typeof source.credit === "string" &&
    typeof source.sourcePage === "string"
  );
};

function validTile(
  key: string,
  t: HeightTileInfo,
  m: HeightTileManifest,
  find: (key: string) => HeightTileInfo | undefined,
): void {
  const address = parseTileKey(key);
  if (!address) throw new Error("Invalid height tile address.");
  const [root, level, x, y] = address;
  if (
    level > rootMaxLevel(root, m.maxLevel) ||
    !t ||
    typeof t.path !== "string" ||
    !TILE_PATH.test(t.path) ||
    ![t.min, t.max, t.lower, t.upper].every(Number.isFinite) ||
    t.min > t.max ||
    t.lower > t.min ||
    t.upper < t.max ||
    t.lower < m.minMeters ||
    t.upper > m.maxMeters ||
    !/^[a-f0-9]{64}$/.test(t.sha256)
  )
    throw new Error("Invalid height tile metadata.");
  if (level > 0) {
    const parent = find(tileKey(root, level - 1, x >> 1, y >> 1));
    if (!parent || parent.lower > t.lower || parent.upper < t.upper)
      throw new Error("Nonconservative height hierarchy.");
  }
}

export function parseHeightTiles(value: unknown, expectedBody?: GlobeBody): HeightTileManifest {
  const m = value as HeightTileManifest;
  if (
    !m ||
    m.version !== 2 ||
    !matchesBody(m, expectedBody) ||
    m.projection !== "geographic-polar" ||
    m.format !== "uint16-le" ||
    !Number.isFinite(m.scaleMeters) ||
    m.scaleMeters <= 0 ||
    !Number.isFinite(m.offsetMeters) ||
    typeof m.verticalDatum !== "string" ||
    !Number.isInteger(m.tileSize) ||
    m.tileSize < 16 ||
    m.tileSize > 256 ||
    !Number.isInteger(m.gutter) ||
    m.gutter < 2 ||
    m.gutter > 8 ||
    !Number.isInteger(m.maxLevel) ||
    m.maxLevel < 0 ||
    m.maxLevel > MAX_LEVEL ||
    !Number.isFinite(m.minMeters) ||
    !Number.isFinite(m.maxMeters) ||
    m.minMeters < m.offsetMeters ||
    m.maxMeters > heightMeters(65535, m) ||
    m.minMeters > m.maxMeters ||
    !m.tiles ||
    typeof m.tiles !== "object" ||
    !Array.isArray(m.sources) ||
    !m.sources.every(validSource)
  )
    throw new Error("Unsupported height tile manifest.");
  const keys = Object.keys(m.tiles);
  if (keys.length > 200000) throw new Error("Height catalog exceeds metadata budget.");
  for (let root = 0; root < ROOT_COUNT; root++)
    if (!m.tiles[tileKey(root, 0, 0, 0)]) throw new Error("Height catalog requires every root.");
  for (const key of keys) validTile(key, m.tiles[key], m, (parent) => m.tiles[parent]);
  if ("pages" in m || "pageLevel" in m) {
    if (
      !Number.isInteger(m.pageLevel) ||
      m.pageLevel! < 0 ||
      m.pageLevel! > 6 ||
      !m.pages ||
      typeof m.pages !== "object" ||
      Object.keys(m.pages).length > 8192
    )
      throw new Error("Invalid height page index.");
    for (const [id, page] of Object.entries(m.pages)) {
      const parent = m.tiles[id];
      if (
        !parent ||
        parseTileKey(id)?.[1] !== m.pageLevel ||
        !page ||
        typeof page.path !== "string" ||
        !PAGE_PATH.test(page.path) ||
        !/^[a-f0-9]{64}$/.test(page.sha256) ||
        !Number.isFinite(page.lower) ||
        !Number.isFinite(page.upper) ||
        page.lower < parent.lower ||
        page.upper > parent.upper ||
        page.lower > page.upper
      )
        throw new Error("Invalid height metadata page.");
    }
  }
  validateTileStorage(m.storage);
  return m;
}
export async function loadHeightTiles(url: string, signal?: AbortSignal, expectedBody?: GlobeBody) {
  const r = await fetch(url, { signal });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`Height tile manifest: HTTP ${r.status}`);
  return parseHeightTiles(await r.json(), expectedBody);
}
export function decodeHeightTile(
  bytes: Uint8Array,
  info: HeightTileInfo,
  width: number,
  encoding: HeightEncoding,
): Uint16Array {
  if (bytes.byteLength !== width * width * 2) throw new Error("Height tile byte length mismatch.");
  const values = new Uint16Array(width * width),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let lo = 65535,
    hi = 0;
  for (let i = 0; i < values.length; i++) {
    const v = (values[i] = view.getUint16(2 * i, true));
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (heightMeters(lo, encoding) !== info.min || heightMeters(hi, encoding) !== info.max)
    throw new Error("Height tile range mismatch.");
  return values;
}
export function sampleTile(
  values: Uint16Array,
  width: number,
  x: number,
  y: number,
  encoding: HeightEncoding,
): number {
  x = Math.max(0, Math.min(width - 1, x));
  y = Math.max(0, Math.min(width - 1, y));
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    x1 = Math.min(width - 1, x0 + 1),
    y1 = Math.min(width - 1, y0 + 1),
    fx = x - x0,
    fy = y - y0;
  return heightMeters(
    (1 - fy) * ((1 - fx) * values[y0 * width + x0] + fx * values[y0 * width + x1]) +
      fy * ((1 - fx) * values[y1 * width + x0] + fx * values[y1 * width + x1]),
    encoding,
  );
}
export function parseHeightPage(
  value: unknown,
  prefix: string,
  manifest: HeightTileManifest,
): Record<string, HeightTileInfo> {
  const entries = (value as { tiles: Record<string, HeightTileInfo> })?.tiles;
  if (!entries || typeof entries !== "object" || Object.keys(entries).length > 20000)
    throw new Error("Invalid height metadata page.");
  const [root, level, x, y] = parseTileKey(prefix)!;
  for (const [key, tile] of Object.entries(entries)) {
    const [tileRoot, l, tx, ty] = parseTileKey(key) ?? [];
    if (
      l === undefined ||
      tileRoot !== root ||
      l <= level ||
      tx! >> (l - level) !== x ||
      ty! >> (l - level) !== y
    )
      throw new Error("Height metadata escaped its page.");
    validTile(key, tile, manifest, (parent) => entries[parent] ?? manifest.tiles[parent]);
  }
  return entries;
}
