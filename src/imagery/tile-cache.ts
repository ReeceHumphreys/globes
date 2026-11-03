import { createTileBytesLoader, type TileBytesLoader } from "../tiles/tile-source.ts";
import { DataArrayTexture, SRGBColorSpace, LinearFilter } from "three/webgpu";
import type { ImageryManifest } from "./manifest.ts";
import type { TileInstances } from "../rendering/tile-instances.ts";
import { screenImportance, cameraFaceUV, type StreamingView } from "./priority.ts";
import { parseRegionalCatalog, type RegionalCatalog } from "./regions.ts";
import { faceToWorld, facePoint } from "../tiles/roots.ts";
import { createResidentTiles, instanceLevel, tileKey } from "../tiles/resident-tiles.ts";

export const IMAGERY_STRIDE = 11;
export interface ImageryBindings {
  revision: number;
  // layers.xy, bestUV.xyzw, parentUV.xyzw, blend. ONE instance buffer.
  data: Float32Array;
}
export type TilePixelsLoader = (url: string, signal: AbortSignal) => Promise<Uint8Array>;

async function decodeTilePixels(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const source = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const result = new Uint8Array(source.length),
      row = bitmap.width * 4;
    for (let y = 0; y < bitmap.height; y++)
      result.set(source.subarray(y * row, (y + 1) * row), (bitmap.height - 1 - y) * row);
    return result;
  } finally {
    bitmap.close();
  }
}

export function createImageryCache(
  manifest: ImageryManifest,
  manifestURL: string,
  terrainCapacity: number,
  onChange: () => void,
  load?: TilePixelsLoader,
  residentLimit = 128,
  options: { fadeMs?: number; prefetchLimit?: number } = {},
) {
  const pixelsLoader =
    (bytes: TileBytesLoader): TilePixelsLoader =>
    async (url, signal) =>
      decodeTilePixels(await bytes(url, signal), signal);
  const baseLoader = load ?? pixelsLoader(createTileBytesLoader(manifest.storage, manifestURL));
  let regionalLoaders = new Map<string, TilePixelsLoader>();
  let regionalURLs = new Map<string, string>();
  let imageryMaxLevel = manifest.maxLevel;
  let regionCount = 0;
  const width = manifest.imageSize,
    layerBytes = width * width * 4;
  const pixels = new Uint8Array(layerBytes * (residentLimit + 1));
  const texture = new DataArrayTexture(pixels, width, width, residentLimit + 1);
  texture.name = "Resident imagery tiles";
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const bindings: ImageryBindings = {
    revision: 0,
    data: new Float32Array(terrainCapacity * IMAGERY_STRIDE),
  };
  const tiles = createResidentTiles({
    slots: residentLimit,
    label: "Imagery",
    maxLevel: () => imageryMaxLevel,
    available: (face, level, x, y) =>
      level <= manifest.maxLevel || regionalURLs.has(tileKey(face, level, x, y)),
    async load({ face, level, x, y }, signal) {
      const key = tileKey(face, level, x, y);
      const relative = manifest.addressing.template
        .replace("{face}", String(face))
        .replace("{level}", String(level))
        .replace("{x}", String(x))
        .replace("{y}", String(y));
      const data = await (regionalLoaders.get(key) ?? baseLoader)(
        regionalURLs.get(key) ?? new URL(relative, manifestURL).href,
        signal,
      );
      if (data.length !== layerBytes)
        throw new Error("Tile image dimensions do not match manifest.");
      return data;
    },
    store(slot, data: Uint8Array) {
      pixels.set(data, slot * layerBytes);
      texture.addLayerUpdate(slot);
      texture.needsUpdate = true;
      return {};
    },
    onChange,
  });
  let disposed = false,
    animating = false;
  let previousOrigin: number[] | undefined,
    previousTime = 0,
    motionAt = -Infinity,
    dx = 0,
    dy = 0,
    dz = 0,
    zooming = false;
  const edge = new Float64Array(3);
  type Resident = NonNullable<ReturnType<typeof tiles.get>>;
  function writeUV(
    i: number,
    image: Resident | undefined,
    instances: TileInstances,
    offset: number,
  ) {
    const j = i * IMAGERY_STRIDE + offset,
      source = i * 4,
      target = bindings.data;
    if (!image) {
      target.fill(0, j, j + 4);
      return;
    }
    const n = 2 ** image.level,
      s = manifest.textureUV.scale,
      p = manifest.textureUV.offset;
    target[j] = p + (instances.faceUVs[source] * n - image.x) * s;
    target[j + 1] = p + (instances.faceUVs[source + 1] * n - image.y) * s;
    target[j + 2] = instances.faceUVs[source + 2] * n * s;
    target[j + 3] = instances.faceUVs[source + 3] * n * s;
  }
  // Returns whether the camera is still inside the recent-motion window.
  function trackMotion(
    origin: Float64Array,
    view: StreamingView | undefined,
    now: number,
  ): boolean {
    if (
      view &&
      previousOrigin &&
      (origin[0] !== previousOrigin[0] ||
        origin[1] !== previousOrigin[1] ||
        origin[2] !== previousOrigin[2])
    ) {
      const dt = Math.max(16, now - previousTime),
        scale = Math.min(300 / dt, 2);
      dx = (origin[0] - previousOrigin[0]) * scale;
      dy = (origin[1] - previousOrigin[1]) * scale;
      dz = (origin[2] - previousOrigin[2]) * scale;
      const distance = Math.hypot(...origin),
        amount = Math.hypot(dx, dy, dz),
        limit = distance * 0.15;
      if (amount > limit) {
        dx *= limit / amount;
        dy *= limit / amount;
        dz *= limit / amount;
      }
      zooming = distance < Math.hypot(...previousOrigin) * 0.999;
      motionAt = now;
    }
    if (view) {
      previousOrigin = Array.from(origin);
      previousTime = now;
    }
    return now - motionAt < 500;
  }
  function speculate(face: number, level: number, x: number, y: number, priority: number) {
    const n = 2 ** level;
    // Cross a cube edge by projecting the candidate center onto its dominant face.
    if (x < 0 || y < 0 || x >= n || y >= n) {
      faceToWorld(face, (x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5, 0.5, edge);
      const [f, u, v] = facePoint(edge[0], edge[1], edge[2]);
      face = f;
      x = Math.min(n - 1, Math.max(0, Math.floor(u * n)));
      y = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
    }
    tiles.prefetch(face, level, x, y, priority);
  }
  // Neighbors in the direction of travel (and children when zooming in), or all
  // four neighbors when still, most important instances first.
  function prefetchAround(
    instances: TileInstances,
    priorities: number[],
    spare: number,
    moving: boolean,
  ) {
    const origin = instances.origin;
    const order = priorities.map((_, i) => i).sort((a, b) => priorities[b] - priorities[a]);
    for (const i of order) {
      if (tiles.prefetchCount >= spare) break;
      const j = i * 4,
        level = Math.min(tiles.cap, instanceLevel(instances, i)),
        face = instances.faces[i],
        n = 2 ** level,
        priority = priorities[i];
      const x = Math.floor(instances.faceUVs[j] * n),
        y = Math.floor(instances.faceUVs[j + 1] * n);
      const candidates: [number, number, number][] = [];
      if (moving) {
        const here = cameraFaceUV(face, origin[0], origin[1], origin[2]);
        const ahead = cameraFaceUV(face, origin[0] + dx, origin[1] + dy, origin[2] + dz);
        const sx = Math.sign(ahead[0] - here[0]),
          sy = Math.sign(ahead[1] - here[1]);
        if (sx) candidates.push([level, x + sx, y]);
        if (sy) candidates.push([level, x, y + sy]);
        if (zooming && level < imageryMaxLevel)
          for (let q = 0; q < 4; q++)
            candidates.push([level + 1, x * 2 + (q & 1), y * 2 + (q >> 1)]);
      } else
        candidates.push([level, x + 1, y], [level, x - 1, y], [level, x, y + 1], [level, x, y - 1]);
      for (const [l, cx, cy] of candidates)
        if (tiles.prefetchCount < spare) speculate(face, l, cx, cy, priority);
    }
  }
  function writeBindings(instances: TileInstances): void {
    for (let i = 0; i < instances.count; i++) {
      const j = i * 4;
      const { best, parent, blend } = tiles.pair(
        instances.faces[i],
        Math.min(imageryMaxLevel, instanceLevel(instances, i)),
        instances.faceUVs[j] + instances.faceUVs[j + 2] / 2,
        instances.faceUVs[j + 1] + instances.faceUVs[j + 3] / 2,
        true,
      );
      animating ||= best !== undefined && blend < 1;
      const row = i * IMAGERY_STRIDE;
      bindings.data[row] = best?.slot ?? 0;
      bindings.data[row + 1] = parent?.slot ?? 0;
      writeUV(i, best, instances, 2);
      writeUV(i, parent, instances, 6);
      bindings.data[row + 10] = blend;
    }
  }
  function update(instances: TileInstances, view?: StreamingView): void {
    if (disposed) return;
    if (instances.count > terrainCapacity)
      throw new RangeError("Imagery terrain capacity exceeded.");
    animating = false;
    const now = view?.now ?? performance.now();
    tiles.setClock(now, view ? Math.max(0, options.fadeMs ?? 250) : 0);
    const priorities = Array.from({ length: instances.count }, (_, i) =>
      screenImportance(instances, i, view),
    );
    tiles.plan(instances, priorities);
    const spare = Math.max(
      0,
      Math.min(options.prefetchLimit ?? 12, residentLimit - tiles.wantedCount),
    );
    const moving = trackMotion(instances.origin, view, now);
    if (view && spare > 0) prefetchAround(instances, priorities, spare, moving);
    writeBindings(instances);
    bindings.revision++;
    tiles.pump();
  }
  return {
    setRegions(value: RegionalCatalog, catalogURL: string) {
      if (disposed) return;
      const catalog = parseRegionalCatalog(value, manifest);
      const urls = new Map<string, string>();
      const loaders = new Map<string, TilePixelsLoader>();
      let maxLevel = manifest.maxLevel;
      for (const site of catalog.sites) {
        maxLevel = Math.max(maxLevel, site.maxLevel);
        const siteBase = new URL(`${site.id}/manifest.json`, catalogURL).href;
        const siteLoader = load ?? pixelsLoader(createTileBytesLoader(site.storage, siteBase));
        for (const key of site.tiles) {
          urls.set(key, new URL(`${site.id}/${key}.png`, catalogURL).href);
          loaders.set(key, siteLoader);
        }
      }
      regionalURLs = urls;
      regionalLoaders = loaders;
      imageryMaxLevel = maxLevel;
      regionCount = catalog.sites.length;
      tiles.invalidate();
      onChange();
    },
    texture,
    bindings,
    update,
    needsFrame: () => animating,
    stats: () => {
      const {
        resident,
        loading,
        wanted,
        prefetch,
        prefetchHits,
        visibleLoads,
        speculativeLoads,
        cap,
      } = tiles.stats();
      return {
        resident,
        loading,
        wanted,
        prefetch,
        prefetchHits,
        visibleLoads,
        speculativeLoads,
        qualityCap: cap,
      };
    },
    status: () => {
      const { resident, loading, prefetchHits, failed, cap } = tiles.stats();
      return `Imagery levels 0–${manifest.maxLevel}${regionCount ? ` + regional layers (${regionCount}, to level ${imageryMaxLevel})` : ""}${cap < imageryMaxLevel ? ` (cache cap ${cap})` : ""} · ${resident} images resident · ${loading} loading · ${prefetchHits} prefetch hits${failed ? ` · ${failed} unavailable` : ""}`;
    },
    dispose() {
      disposed = true;
      tiles.dispose();
      texture.dispose();
    },
  };
}
export type ImageryCache = ReturnType<typeof createImageryCache>;
