import { createTileBytesLoader, type TileBytesLoader } from "../tiles/tile-source.ts";
import { rootMaxLevel, tileKey } from "../tiles/roots.ts";
import type { ImageryManifest } from "./manifest.ts";
import { parseRegionalCatalog, type RegionalCatalog } from "./regions.ts";
import { decodeImage, type ImagerySource } from "./source.ts";

async function decodeTilePixels(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const { data, width, height } = await decodeImage(new Blob([new Uint8Array(bytes)]));
  const result = new Uint8Array(data.length),
    row = width * 4;
  for (let y = 0; y < height; y++)
    result.set(data.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  return result;
}

/** Imagery from a published dataset: a manifest and, once set, its regional catalog. */
export function createDatasetImagery(
  manifest: ImageryManifest,
  manifestURL: string,
  load?: TileBytesLoader,
): ImagerySource & { setRegions(catalog: RegionalCatalog, catalogURL: string): void } {
  const pixels =
    (bytes: TileBytesLoader): TileBytesLoader =>
    async (url, signal) =>
      decodeTilePixels(await bytes(url, signal), signal);
  const baseLoader = load ?? pixels(createTileBytesLoader(manifest.storage, manifestURL));
  let regionalLoaders = new Map<string, TileBytesLoader>();
  let regionalURLs = new Map<string, string>();
  let deepest = manifest.maxLevel;
  let regionCount = 0;
  return {
    tileSize: manifest.tileSize,
    gutter: manifest.gutter,
    maxLevel: () => deepest,
    has: ({ root, level, x, y }) =>
      level <= rootMaxLevel(root, manifest.maxLevel) ||
      regionalURLs.has(tileKey(root, level, x, y)),
    load({ root, level, x, y }, signal) {
      const key = tileKey(root, level, x, y);
      return (regionalLoaders.get(key) ?? baseLoader)(
        regionalURLs.get(key) ?? new URL(`${key}.png`, manifestURL).href,
        signal,
      );
    },
    describe: () =>
      `Imagery levels 0–${manifest.maxLevel}${regionCount ? ` + regional layers (${regionCount}, to level ${deepest})` : ""}`,
    setRegions(value, catalogURL) {
      const catalog = parseRegionalCatalog(value, manifest);
      const urls = new Map<string, string>();
      const loaders = new Map<string, TileBytesLoader>();
      let maxLevel = manifest.maxLevel;
      for (const site of catalog.sites) {
        maxLevel = Math.max(maxLevel, site.maxLevel);
        const siteBase = new URL(`${site.id}/`, catalogURL).href;
        const siteLoader = load ?? pixels(createTileBytesLoader(site.storage, siteBase));
        for (const key of site.tiles) {
          urls.set(key, new URL(`${site.id}/${key}.png`, catalogURL).href);
          loaders.set(key, siteLoader);
        }
      }
      regionalURLs = urls;
      regionalLoaders = loaders;
      deepest = maxLevel;
      regionCount = catalog.sites.length;
    },
  };
}
