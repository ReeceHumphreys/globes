import { createTileBytesLoader, fetchTileBytes } from "../tiles/tile-source.ts";
import { createShadowHeightIndex } from "../rendering/shadow-height-index.ts";
import {
  DataArrayTexture,
  RGFormat,
  UnsignedByteType,
  NearestFilter,
  NoColorSpace,
} from "three/webgpu";
import type { TileInstances } from "../rendering/tile-instances.ts";
import { facePoint } from "../tiles/roots.ts";
import {
  createResidentTiles,
  DEFAULT_FADE_MS,
  instanceCenter,
  instanceLevel,
  tileKey,
  tileKeyAt,
} from "../tiles/resident-tiles.ts";
import {
  HEIGHT_FACE,
  HEIGHT_RANGE,
  HEIGHT_STRIDE,
  writeTilePair,
} from "../rendering/binding-row.ts";
import { screenImportance, type StreamingView } from "../imagery/priority.ts";
import {
  heightMeters,
  parseHeightPage,
  decodeHeightTile,
  sampleTile,
  ZERO_HEIGHT_BYTES,
  type HeightTileManifest,
  type HeightTileLoader,
} from "./tiles.ts";

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createHeightTileCache(
  manifest: HeightTileManifest,
  url: string,
  capacity: number,
  onChange: () => void,
  load: HeightTileLoader = createTileBytesLoader(manifest.storage, url),
  residentLimit = 64,
  {
    fadeMs = DEFAULT_FADE_MS,
    loadPage = fetchTileBytes,
    onError = console.warn,
  }: {
    fadeMs?: number;
    /** Metadata pages are plain files, even when tiles come from an archive. */
    loadPage?: HeightTileLoader;
    onError?(error: unknown): void;
  } = {},
) {
  const width = manifest.tileSize + 2 * manifest.gutter,
    layerBytes = width * width * 2;
  const bytes = new Uint8Array(layerBytes * (residentLimit + 1));
  // Slot zero is the zero-meter sphere, not the uint16 value zero (-10 km).
  for (let i = 0; i < layerBytes; i += 2) {
    bytes.set(ZERO_HEIGHT_BYTES, i);
  }
  const texture = new DataArrayTexture(bytes, width, width, residentLimit + 1);
  texture.name = "Resident numeric height tiles";
  texture.format = RGFormat;
  texture.type = UnsignedByteType;
  texture.colorSpace = NoColorSpace;
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  const slotVersions = new Uint32Array(residentLimit + 1);
  let contentRevision = 0;
  const shadowIndex = createShadowHeightIndex(residentLimit, manifest.maxLevel);
  const bindings = { data: new Float32Array(capacity * HEIGHT_STRIDE) };
  const rangeMemo = new Map<string, [number, number]>();
  // Root metadata plus whichever fine-tile pages are loaded around the view.
  const metadata = { ...manifest.tiles };
  const loadedPages = new Map<string, { keys: string[]; used: number }>(),
    pendingPages = new Map<string, AbortController>(),
    failedPages = new Set<string>();
  let wantedPages = new Set<string>();
  let drawing: TileInstances | undefined;
  let clock = 0,
    pageFrame = 0,
    disposed = false,
    animating = false;
  const tiles = createResidentTiles({
    slots: residentLimit,
    label: "Height",
    maxLevel: () => manifest.maxLevel,
    available: (face, level, x, y) => tileKey(face, level, x, y) in metadata,
    coverGround: true,
    busy: () => pendingPages.size,
    async load({ face, level, x, y }, signal) {
      const info = metadata[tileKey(face, level, x, y)];
      if (!info) throw new Error("Height tile metadata is no longer loaded.");
      const data = await load(new URL(info.path, url).href, signal);
      if ((await sha256Hex(data)) !== info.sha256)
        throw new Error("Height tile checksum mismatch.");
      const values = decodeHeightTile(data, info, width);
      // Largest half-sample step, used to bound sub-tile ranges around the center.
      let stepX = 0,
        stepY = 0;
      for (let y = 0; y < width; y++)
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (x + 1 < width) stepX = Math.max(stepX, Math.abs(values[i + 1] - values[i]) * 0.5);
          if (y + 1 < width) stepY = Math.max(stepY, Math.abs(values[i + width] - values[i]) * 0.5);
        }
      return { data, values, stepX, stepY };
    },
    store(slot, { data, values, stepX, stepY }) {
      bytes.set(data, slot * layerBytes);
      slotVersions[slot]++;
      contentRevision++;
      texture.addLayerUpdate(slot);
      texture.needsUpdate = true;
      rangeMemo.clear();
      return { values, stepX, stepY };
    },
    onChange() {
      onChange();
      pumpPages();
    },
    onError,
  });
  const texels = {
    scale: manifest.tileSize / width,
    offset: manifest.gutter / width,
    flipV: true,
  };
  type Resident = NonNullable<ReturnType<typeof tiles.get>>;
  function sample(r: Resident | undefined, u: number, v: number) {
    if (!r) return 0;
    const n = 2 ** r.level;
    return sampleTile(
      r.values,
      width,
      manifest.gutter + (u * n - r.x) * manifest.tileSize - 0.5,
      manifest.gutter + (1 - (v * n - r.y)) * manifest.tileSize - 0.5,
    );
  }
  function pageAt(f: number, u: number, v: number) {
    return manifest.pages ? tileKeyAt(f, manifest.pageLevel!, u, v) : undefined;
  }
  function pumpPages() {
    if (disposed) return;
    for (const id of wantedPages) {
      if (tiles.stats().loading + pendingPages.size >= 4) break;
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
          if (loadedPages.size >= 16) {
            const oldest = [...loadedPages]
              .filter(([key]) => !wantedPages.has(key))
              .sort((a, b) => a[1].used - b[1].used)[0];
            if (!oldest) return;
            for (const key of oldest[1].keys) delete metadata[key];
            loadedPages.delete(oldest[0]);
          }
          rangeMemo.clear();
          Object.assign(metadata, entries);
          loadedPages.set(id, { keys: Object.keys(entries), used: pageFrame });
          tiles.invalidate();
        })
        .catch((error) => {
          if (!disposed && !controller.signal.aborted) {
            failedPages.add(id);
            onError(new Error(`Height metadata page ${id} failed`, { cause: error }));
          }
        })
        .finally(() => {
          pendingPages.delete(id);
          if (disposed) return;
          tiles.pump();
          pumpPages();
          onChange();
        });
    }
  }
  function wantPages(instances: TileInstances) {
    pageFrame++;
    wantedPages = new Set();
    const want = (f: number, u: number, v: number) => {
      const id = pageAt(f, u, v);
      if (id && manifest.pages![id] && wantedPages.size < 16) {
        wantedPages.add(id);
        const page = loadedPages.get(id);
        if (page) page.used = pageFrame;
      }
    };
    want(...facePoint(instances.origin[0], instances.origin[1], instances.origin[2]));
    for (let i = 0; i < instances.count; i++)
      if (instanceLevel(instances, i) > (manifest.pageLevel ?? 20))
        want(instances.faces[i], ...instanceCenter(instances, i));
    for (const [id, c] of pendingPages) if (!wantedPages.has(id)) c.abort();
    for (const id of failedPages) if (!wantedPages.has(id)) failedPages.delete(id);
  }
  function update(instances: TileInstances, view?: StreamingView) {
    if (disposed) return;
    if (instances.count > capacity) throw new RangeError("Height instance capacity exceeded.");
    drawing = instances;
    wantPages(instances);
    if (view) clock = view.now;
    tiles.setClock(clock, fadeMs);
    // Start late network arrivals on the frame that reveals them, not at the
    // stale clock from their request. Activate coarse offscreen roots too so
    // shadow rays have the same smoothly arriving global fallback.
    animating = tiles.startRootFades();
    noteFade();
    const previousCap = tiles.cap;
    tiles.plan(
      instances,
      Array.from({ length: instances.count }, (_, i) => screenImportance(instances, i, view)),
    );
    if (tiles.cap !== previousCap) rangeMemo.clear();
    for (let i = 0; i < instances.count; i++) {
      const j = i * 4,
        level = instanceLevel(instances, i),
        [u, v] = instanceCenter(instances, i);
      const p = tiles.pair(instances.faces[i], level, u, v, true),
        row = i * HEIGHT_STRIDE;
      writeTilePair(bindings.data, row, p, instances, i, texels);
      bindings.data[row + HEIGHT_FACE] = instances.faces[i];
      rangeForTile(
        instances.faces[i],
        level,
        Math.round(instances.faceUVs[j] / instances.faceUVs[j + 2]),
        Math.round(instances.faceUVs[j + 1] / instances.faceUVs[j + 3]),
        bindingRange,
      );
      bindings.data[row + HEIGHT_RANGE] = bindingRange[1] - bindingRange[0];
      animating ||= !!p.best && p.blend < 1;
    }
    const [f, u, v] = facePoint(instances.origin[0], instances.origin[1], instances.origin[2]);
    const ground = tiles.pair(f, drawLevelAt(f, u, v), u, v, true);
    shadowIndex.write(tiles.resident(), clock, fadeMs);
    animating ||= !!ground.best && ground.blend < 1;
    tiles.pump();
    pumpPages();
  }
  function drawLevelAt(face: number, u: number, v: number): number {
    if (drawing)
      for (let i = 0; i < drawing.count; i++) {
        const j = i * 4;
        if (
          drawing.faces[i] === face &&
          u >= drawing.faceUVs[j] &&
          u <= drawing.faceUVs[j] + drawing.faceUVs[j + 2] &&
          v >= drawing.faceUVs[j + 1] &&
          v <= drawing.faceUVs[j + 1] + drawing.faceUVs[j + 3]
        )
          return instanceLevel(drawing, i);
      }
    return manifest.maxLevel;
  }
  function sampleDirection(x: number, y: number, z: number) {
    const [f, u, v] = facePoint(x, y, z),
      p = tiles.pair(f, drawLevelAt(f, u, v), u, v);
    return sample(p.parent, u, v) * (1 - p.blend) + sample(p.best, u, v) * p.blend;
  }
  function recordRange(
    r: Resident | undefined,
    l: number,
    x: number,
    y: number,
    out: Float64Array,
  ) {
    if (!r) {
      out[0] = out[1] = 0;
      return;
    }
    // Decoded min/max already cover every sample in this tile. A finer terrain
    // leaf is only a sub-rectangle, so that case still walks the samples.
    if (l <= r.level) {
      const tile = metadata[r.key];
      if (tile) {
        out[0] = tile.min - 0.5;
        out[1] = tile.max + 0.5;
        return;
      }
    }
    const factor = 2 ** (l - r.level),
      px = manifest.gutter + (x / factor - r.x) * manifest.tileSize - 0.5,
      py = manifest.gutter + (1 - ((y + 1) / factor - r.y)) * manifest.tileSize - 0.5,
      span = manifest.tileSize / factor;
    let lo = 65535,
      hi = 0;
    for (
      let yy = Math.max(0, Math.floor(py));
      yy <= Math.min(width - 1, Math.ceil(py + span));
      yy++
    )
      for (
        let xx = Math.max(0, Math.floor(px));
        xx <= Math.min(width - 1, Math.ceil(px + span));
        xx++
      ) {
        const value = r.values[yy * width + xx];
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    const center = sampleTile(r.values, width, px + span * 0.5, py + span * 0.5),
      deviation = (r.stepX + r.stepY) * span * 0.5;
    out[0] = Math.max(heightMeters(lo), center - deviation) - 0.5;
    out[1] = Math.min(heightMeters(hi), center + deviation) + 0.5;
  }
  const temp = new Float64Array(2);
  const bindingRange = new Float64Array(2);
  // The stored range includes the fading parent. It stays the same until that
  // fade ends, so intermediate frames keep the memory.
  let fadeOpen = false;
  function noteFade(): void {
    const still = tiles.fading();
    if (fadeOpen && !still) rangeMemo.clear();
    fadeOpen = still;
  }
  function rangeForTile(f: number, l: number, x: number, y: number, out: Float64Array) {
    const id = tileKey(f, l, x, y),
      memo = rangeMemo.get(id);
    if (memo) {
      out[0] = memo[0];
      out[1] = memo[1];
      return;
    }
    const u = (x + 0.5) / 2 ** l,
      v = (y + 0.5) / 2 ** l;
    let info = metadata[tileKey(f, 0, 0, 0)],
      record: Resident | undefined,
      selectedLevel = 0;
    for (let level = 0; level <= Math.min(l, manifest.maxLevel); level++) {
      const id = tileKeyAt(f, level, u, v);
      if (metadata[id]) {
        info = metadata[id];
        record = tiles.get(id);
        selectedLevel = level;
      }
    }
    const pageID = pageAt(f, u, v),
      pageMissing = pageID && manifest.pages?.[pageID] && !loadedPages.has(pageID);
    if (record && l > selectedLevel && !pageMissing) recordRange(record, l, x, y, out);
    else {
      out[0] = info.lower;
      out[1] = info.upper;
    }
    const p = tiles.pair(f, l, u, v);
    for (const r of p.blend < 1 ? [p.best, p.parent] : [p.best]) {
      recordRange(r, l, x, y, temp);
      out[0] = Math.min(out[0], temp[0]);
      out[1] = Math.max(out[1], temp[1]);
    }
    if (rangeMemo.size >= 32768) rangeMemo.clear();
    rangeMemo.set(id, [out[0], out[1]]);
  }
  return {
    shadowIndex: shadowIndex.texture,
    slotVersions,
    get revision() {
      return contentRevision + shadowIndex.revision;
    },
    texture,
    bindings,
    manifest,
    update,
    sampleDirection,
    rangeForTile,
    advance(now: number) {
      clock = now;
      tiles.setClock(clock, fadeMs);
      noteFade();
    },
    needsFrame: () => animating,
    stats: () => {
      const { resident, loading, wanted, failed, cap } = tiles.stats();
      return {
        resident,
        loading: loading + pendingPages.size,
        wanted,
        failed: failed + failedPages.size,
        cap,
        metadataPages: loadedPages.size,
      };
    },
    status: () => {
      const { resident, loading, failed } = tiles.stats();
      const busy = loading + pendingPages.size,
        unavailable = failed + failedPages.size;
      return `Tiled elevation · ${resident}/${residentLimit} resident · ${busy} loading${unavailable ? ` · ${unavailable} unavailable` : ""}`;
    },
    dispose() {
      disposed = true;
      tiles.dispose();
      for (const c of pendingPages.values()) c.abort();
      pendingPages.clear();
      loadedPages.clear();
      rangeMemo.clear();
      texture.dispose();
      shadowIndex.dispose();
    },
  };
}
export type HeightTileCache = ReturnType<typeof createHeightTileCache>;
