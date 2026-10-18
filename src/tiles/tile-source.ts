import { PMTiles, SharedPromiseCache } from "pmtiles";

/** PMTiles indexes face-local coordinates; this profile is not a Mercator map. */
export interface PMTilesStorage {
  type: "pmtiles";
  profile: "normalized-cube-v1";
  /** Keys are source-prefix/face, or simply face for imagery. */
  archives: Record<string, string>;
}

export function validateTileStorage(value: unknown): asserts value is PMTilesStorage | undefined {
  if (value === undefined) return;
  const s = value as PMTilesStorage;
  if (
    !s ||
    s.type !== "pmtiles" ||
    s.profile !== "normalized-cube-v1" ||
    !s.archives ||
    typeof s.archives !== "object" ||
    Array.isArray(s.archives) ||
    Object.keys(s.archives).length === 0 ||
    Object.keys(s.archives).length > 4096
  )
    throw new Error("Invalid PMTiles storage descriptor.");
  for (const [key, path] of Object.entries(s.archives)) {
    if (
      !/^(?:[a-zA-Z0-9_-]+\/)*[0-5]$/.test(key) ||
      typeof path !== "string" ||
      !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.pmtiles$/.test(path)
    )
      throw new Error("Invalid PMTiles archive reference.");
  }
}

export type TileBytesLoader = (url: string, signal: AbortSignal) => Promise<Uint8Array>;

export async function fetchTileBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Tile: HTTP ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Keep legacy virtual tile URLs inside the cache; resolve their bytes here. */
export function createTileBytesLoader(
  storage: PMTilesStorage | undefined,
  manifestURL: string,
): TileBytesLoader {
  validateTileStorage(storage);
  if (!storage) return fetchTileBytes;
  const base = new URL(".", manifestURL);
  // SharedPromiseCache tracks each directory consumer's AbortSignal. One tile
  // being cancelled must not cancel a directory needed by another tile.
  const directories = new SharedPromiseCache(128);
  const archives = new Map<string, PMTiles>();
  return async (url, signal) => {
    signal.throwIfAborted();
    const tileURL = new URL(url);
    if (tileURL.origin !== base.origin || !tileURL.pathname.startsWith(base.pathname))
      throw new Error("Tile URL escapes its PMTiles dataset.");
    const path = decodeURIComponent(tileURL.pathname.slice(base.pathname.length));
    const match = /^((?:[a-zA-Z0-9_-]+\/)*[0-5])\/(\d+)\/(\d+)\/(\d+)\.(png|u16)$/.exec(path);
    if (!match) throw new Error("Invalid PMTiles cube address.");
    const [, key, level, xx, yy] = match;
    const z = Number(level),
      x = Number(xx),
      y = Number(yy);
    if (z > 20 || x >= 2 ** z || y >= 2 ** z) throw new Error("PMTiles cube address out of range.");
    const relative = storage.archives[key];
    if (!relative) throw new Error(`No PMTiles archive for ${key}`);
    let archive = archives.get(key);
    if (!archive) {
      archive = new PMTiles(new URL(relative, base).href, directories);
      archives.set(key, archive);
    }
    const tile = await archive.getZxy(z, x, y, signal);
    signal.throwIfAborted();
    if (!tile) throw new Error(`Tile absent from PMTiles archive: ${path}`);
    return new Uint8Array(tile.data);
  };
}
