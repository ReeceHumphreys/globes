import { validateTileStorage, type PMTilesStorage } from "../tiles/tile-source.ts";
import { matchesBody, type GlobeBody } from "../body.ts";
/** Meters from a stored uint16 height. decode-height.wgsl matches it. */
export const heightMeters = (value: number) => value * 0.5 - 10000;
/** The stored bytes of zero meters, little-endian. */
export const ZERO_HEIGHT_BYTES = [32, 78] as const;
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
  version: 1;
  body: string;
  radiusMeters: number;
  projection: "normalized-cube";
  format: "uint16-le";
  scaleMeters: 0.5;
  offsetMeters: -10000;
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
export function parseHeightTiles(value: unknown, expectedBody?: GlobeBody): HeightTileManifest {
  const m = value as HeightTileManifest;
  if (
    !m ||
    m.version !== 1 ||
    !matchesBody(m, expectedBody) ||
    m.projection !== "normalized-cube" ||
    m.format !== "uint16-le" ||
    m.scaleMeters !== 0.5 ||
    m.offsetMeters !== -10000 ||
    !Number.isInteger(m.tileSize) ||
    m.tileSize < 16 ||
    m.tileSize > 256 ||
    !Number.isInteger(m.gutter) ||
    m.gutter < 2 ||
    m.gutter > 8 ||
    !Number.isInteger(m.maxLevel) ||
    m.maxLevel < 0 ||
    m.maxLevel > 20 ||
    !Number.isFinite(m.minMeters) ||
    !Number.isFinite(m.maxMeters) ||
    m.minMeters < -10000 ||
    m.maxMeters > 22767.5 ||
    m.minMeters > m.maxMeters ||
    !m.tiles ||
    typeof m.tiles !== "object" ||
    !Array.isArray(m.sources)
  )
    throw new Error("Unsupported height tile manifest.");
  const keys = Object.keys(m.tiles);
  if (keys.length > 200000) throw new Error("Height catalog exceeds metadata budget.");
  for (let f = 0; f < 6; f++)
    if (!m.tiles[`${f}/0/0/0`]) throw new Error("Height catalog requires all six roots.");
  for (const key of keys) {
    const t = m.tiles[key];
    if (!/^[0-5]\/\d+\/\d+\/\d+$/.test(key)) throw new Error("Invalid height tile address.");
    const [f, l, x, y] = key.split("/").map(Number);
    if (
      l > m.maxLevel ||
      x >= 2 ** l ||
      y >= 2 ** l ||
      key !== `${f}/${l}/${x}/${y}` ||
      !t ||
      typeof t.path !== "string" ||
      !/^([a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.u16$/.test(t.path) ||
      ![t.min, t.max, t.lower, t.upper].every(Number.isFinite) ||
      t.min > t.max ||
      t.lower > t.min ||
      t.upper < t.max ||
      t.lower < m.minMeters ||
      t.upper > m.maxMeters ||
      !/^[a-f0-9]{64}$/.test(t.sha256)
    )
      throw new Error("Invalid height tile metadata.");
    if (l > 0) {
      const parent = m.tiles[`${f}/${l - 1}/${x >> 1}/${y >> 1}`];
      if (!parent || parent.lower > t.lower || parent.upper < t.upper)
        throw new Error("Nonconservative height hierarchy.");
    }
  }
  if (m.pages) {
    if (
      !Number.isInteger(m.pageLevel) ||
      m.pageLevel! < 0 ||
      m.pageLevel! > 5 ||
      Object.keys(m.pages).length > 8192
    )
      throw new Error("Invalid height page index.");
    for (const [id, page] of Object.entries(m.pages)) {
      const parent = m.tiles[id];
      if (
        !parent ||
        Number(id.split("/")[1]) !== m.pageLevel ||
        !page ||
        typeof page.path !== "string" ||
        !/^([a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/.test(page.path) ||
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
export type HeightTileLoader = (url: string, signal: AbortSignal) => Promise<Uint8Array>;
export function decodeHeightTile(
  bytes: Uint8Array,
  info: HeightTileInfo,
  width: number,
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
  if (heightMeters(lo) !== info.min || heightMeters(hi) !== info.max)
    throw new Error("Height tile range mismatch.");
  return values;
}
export function sampleTile(values: Uint16Array, width: number, x: number, y: number): number {
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
  const [f, level, x, y] = prefix.split("/").map(Number);
  for (const key of Object.keys(entries)) {
    const [ff, l, xx, yy] = key.split("/").map(Number);
    if (ff !== f || l <= level || xx >> (l - level) !== x || yy >> (l - level) !== y)
      throw new Error("Height metadata escaped its page.");
  }
  parseHeightTiles({ ...manifest, tiles: { ...manifest.tiles, ...entries }, pages: undefined });
  return entries;
}
