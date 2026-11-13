import { validateTileStorage, type PMTilesStorage } from "../tiles/tile-source.ts";
import { parseTileKey, rootMaxLevel, tileKey } from "../tiles/roots.ts";
import type { ImageryManifest } from "./manifest.ts";

/** The contract's deepest level for a site. */
const MAX_SITE_LEVEL = 17;

export interface RegionalSite {
  storage?: PMTilesStorage;
  id: string;
  name: string;
  latitudeDeg: number;
  longitudeDeg: number;
  radiusMeters: number;
  maxLevel: number;
  source: { sourcePage: string; credit: string; nativeResolutionMeters: number };
  tiles: string[];
}
export interface RegionalCatalog {
  version: 1;
  body: string;
  radiusMeters: number;
  baseId: string;
  baseMaxLevel: number;
  tileSize: number;
  gutter: number;
  sites: RegionalSite[];
}

export function parseRegionalCatalog(value: unknown, base: ImageryManifest): RegionalCatalog {
  const c = value as RegionalCatalog;
  if (
    !c ||
    c.version !== 1 ||
    c.body !== base.body ||
    c.radiusMeters !== base.radiusMeters ||
    c.baseId !== base.id ||
    c.baseMaxLevel !== base.maxLevel ||
    c.tileSize !== base.tileSize ||
    c.gutter !== base.gutter ||
    !Array.isArray(c.sites) ||
    c.sites.length > 64
  )
    throw new Error("Incompatible regional imagery catalog.");
  const ids = new Set<string>(),
    addresses = new Set<string>();
  for (const site of c.sites) {
    if (
      !site ||
      typeof site.id !== "string" ||
      !/^[a-z0-9-]+$/.test(site.id) ||
      ids.has(site.id) ||
      typeof site.name !== "string" ||
      !Number.isFinite(site.latitudeDeg) ||
      Math.abs(site.latitudeDeg) > 90 ||
      !Number.isFinite(site.longitudeDeg) ||
      Math.abs(site.longitudeDeg) > 180 ||
      !Number.isFinite(site.radiusMeters) ||
      site.radiusMeters <= 0 ||
      !Number.isInteger(site.maxLevel) ||
      site.maxLevel <= base.maxLevel ||
      site.maxLevel > MAX_SITE_LEVEL ||
      !Array.isArray(site.tiles) ||
      site.tiles.length > 20000 ||
      !site.source ||
      typeof site.source.sourcePage !== "string" ||
      typeof site.source.credit !== "string" ||
      !Number.isFinite(site.source.nativeResolutionMeters) ||
      site.source.nativeResolutionMeters <= 0
    )
      throw new Error("Invalid regional imagery site.");
    validateTileStorage(site.storage);
    ids.add(site.id);
    const own = new Set<string>();
    for (const key of site.tiles) {
      const address = parseTileKey(key);
      if (!address) throw new Error("Invalid regional tile address.");
      const [root, level] = address;
      if (
        level <= rootMaxLevel(root, base.maxLevel) ||
        level > rootMaxLevel(root, site.maxLevel) ||
        addresses.has(key)
      )
        throw new Error("Invalid or overlapping regional tile address.");
      addresses.add(key);
      own.add(key);
    }
    // A complete ancestor chain keeps progressive loading/fades intact.
    for (const key of own) {
      const [root, level, x, y] = parseTileKey(key)!;
      if (
        level > rootMaxLevel(root, base.maxLevel) + 1 &&
        !own.has(tileKey(root, level - 1, x >> 1, y >> 1))
      )
        throw new Error("Regional tile is missing its parent.");
    }
  }
  return c;
}

export async function loadRegionalCatalog(
  url: string,
  base: ImageryManifest,
  signal?: AbortSignal,
) {
  const response = await fetch(url, { signal });
  if (response.status === 404) return undefined; // Optional, opt-in generated data.
  if (!response.ok) throw new Error(`Regional imagery catalog: HTTP ${response.status}`);
  return parseRegionalCatalog(await response.json(), base);
}
