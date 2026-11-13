import {
  createTileBytesLoader,
  fetchTileBytes,
  type TileBytesLoader,
} from "../tiles/tile-source.ts";
import { tileKey } from "../tiles/roots.ts";
import type { TileAddress } from "../tiles/resident-tiles.ts";
import { decodeHeightTile, parseHeightPage, type HeightTileManifest } from "./tiles.ts";
import type { HeightSource } from "./source.ts";

const MAX_PAGES = 16,
  PAGES_IN_FLIGHT = 4,
  PAGE_ATTEMPTS = 3;

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Heights from a published dataset: its manifest, its checksummed tiles, and the metadata
 * pages that list fine tiles around the view.
 */
export function createDatasetHeights(
  manifest: HeightTileManifest,
  url: string,
  {
    load = createTileBytesLoader(manifest.storage, url),
    loadPage = fetchTileBytes,
    onError = console.warn,
  }: {
    load?: TileBytesLoader;
    /** Metadata pages are plain files, even when tiles come from an archive. */
    loadPage?: TileBytesLoader;
    onError?(error: unknown): void;
  } = {},
): HeightSource {
  const width = manifest.tileSize + 2 * manifest.gutter;
  // Root metadata plus whichever fine-tile pages are loaded around the view.
  const metadata = { ...manifest.tiles };
  const loadedPages = new Map<string, { keys: string[]; used: number }>(),
    pendingPages = new Map<string, AbortController>(),
    failedPages = new Set<string>(),
    pageAttempts = new Map<string, number>();
  let wantedPages = new Set<string>(),
    frame = 0,
    disposed = false,
    changed = () => {};

  function pump() {
    if (disposed) return;
    for (const id of wantedPages) {
      if (pendingPages.size >= PAGES_IN_FLIGHT) break;
      if (loadedPages.has(id) || pendingPages.has(id) || failedPages.has(id)) continue;
      const page = manifest.pages![id],
        controller = new AbortController();
      pendingPages.set(id, controller);
      void loadPage(new URL(page.path, url).href, controller.signal)
        .then(async (pageBytes) => {
          if ((await sha256Hex(pageBytes)) !== page.sha256)
            throw new Error("Height metadata page checksum mismatch.");
          if (disposed || controller.signal.aborted || !wantedPages.has(id)) return;
          const entries = parseHeightPage(
            JSON.parse(new TextDecoder().decode(pageBytes)),
            id,
            manifest,
          );
          if (loadedPages.size >= MAX_PAGES) {
            const oldest = [...loadedPages]
              .filter(([key]) => !wantedPages.has(key))
              .sort((a, b) => a[1].used - b[1].used)[0];
            if (!oldest) return;
            for (const key of oldest[1].keys) delete metadata[key];
            loadedPages.delete(oldest[0]);
          }
          Object.assign(metadata, entries);
          loadedPages.set(id, { keys: Object.keys(entries), used: frame });
          pageAttempts.delete(id);
        })
        .catch((error: unknown) => {
          if (disposed || controller.signal.aborted) return;
          const tries = (pageAttempts.get(id) ?? 0) + 1;
          pageAttempts.set(id, tries);
          if (tries < PAGE_ATTEMPTS) return;
          failedPages.add(id);
          onError(new Error(`Height metadata page ${id} failed`, { cause: error }));
        })
        .finally(() => {
          pendingPages.delete(id);
          if (disposed) return;
          pump();
          changed();
        });
    }
  }

  return {
    tileSize: manifest.tileSize,
    gutter: manifest.gutter,
    maxLevel: manifest.maxLevel,
    scaleMeters: manifest.scaleMeters,
    offsetMeters: manifest.offsetMeters,
    minMeters: manifest.minMeters,
    maxMeters: manifest.maxMeters,
    verticalDatum: manifest.verticalDatum,
    bounds({ root, level, x, y }: TileAddress) {
      const key = tileKey(root, level, x, y),
        info = metadata[key];
      if (!info) return undefined;
      // Only tiles at the page level have pages, and a page lists their descendants.
      const partial = !!manifest.pages?.[key] && !loadedPages.has(key);
      return { min: info.min, max: info.max, lower: info.lower, upper: info.upper, partial };
    },
    async load({ root, level, x, y }, signal) {
      const info = metadata[tileKey(root, level, x, y)];
      if (!info) throw new Error("Height tile metadata is no longer loaded.");
      const data = await load(new URL(info.path, url).href, signal);
      if ((await sha256Hex(data)) !== info.sha256)
        throw new Error("Height tile checksum mismatch.");
      return decodeHeightTile(data, info, width, manifest);
    },
    focus(tiles, onChange) {
      changed = onChange;
      frame++;
      wantedPages = new Set();
      const pageLevel = manifest.pageLevel;
      if (manifest.pages && pageLevel !== undefined)
        for (const { root, level, x, y } of tiles) {
          if (level <= pageLevel || wantedPages.size >= MAX_PAGES) continue;
          const shift = level - pageLevel,
            id = tileKey(root, pageLevel, x >> shift, y >> shift);
          if (!manifest.pages[id]) continue;
          wantedPages.add(id);
          const page = loadedPages.get(id);
          if (page) page.used = frame;
        }
      for (const [id, c] of pendingPages) if (!wantedPages.has(id)) c.abort();
      for (const id of failedPages) if (!wantedPages.has(id)) failedPages.delete(id);
      for (const id of pageAttempts.keys()) if (!wantedPages.has(id)) pageAttempts.delete(id);
      pump();
    },
    pending: () => pendingPages.size,
    dispose() {
      disposed = true;
      for (const c of pendingPages.values()) c.abort();
      pendingPages.clear();
      loadedPages.clear();
    },
  };
}
