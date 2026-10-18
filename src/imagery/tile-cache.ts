import { createTileBytesLoader, type TileBytesLoader } from "../tiles/tile-source.ts";
import { DataArrayTexture, SRGBColorSpace, LinearFilter } from "three/webgpu";
import type { ImageryManifest } from "./manifest.ts";
import type { TileInstances } from "../rendering/tile-instances.ts";
import { screenImportance, cameraFaceUV, type StreamingView } from "./priority.ts";
import { parseRegionalCatalog, type RegionalCatalog } from "./regions.ts";
import { faceToWorld } from "../tiles/roots.ts";

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

type RecordEntry = {
  key: string;
  face: number;
  level: number;
  x: number;
  y: number;
  slot: number;
  used: number;
  priority: number;
  fadeStart?: number;
};
type Pending = { controller: AbortController; speculative: boolean };

// Cube face whose axis is largest. Ties prefer X, then Y. Zero counts as the negative face.
function dominantFace(x: number, y: number, z: number): number {
  const ax = Math.abs(x),
    ay = Math.abs(y),
    az = Math.abs(z);
  if (ax >= ay && ax >= az) return x > 0 ? 0 : 1;
  if (ay >= az) return y > 0 ? 2 : 3;
  return z > 0 ? 4 : 5;
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
  if (residentLimit < 6 || residentLimit > 255 || !Number.isInteger(residentLimit))
    throw new RangeError("Imagery slots must be 6..255.");
  const pixelsLoader =
    (bytes: TileBytesLoader): TilePixelsLoader =>
    async (url, signal) =>
      decodeTilePixels(await bytes(url, signal), signal);
  const baseLoader = load ?? pixelsLoader(createTileBytesLoader(manifest.storage, manifestURL));
  let regionalLoaders = new Map<string, TilePixelsLoader>();
  let imageryMaxLevel = manifest.maxLevel;
  let regionCount = 0;
  let regionalURLs = new Map<string, string>();
  const available = (face: number, level: number, x: number, y: number) =>
    level <= manifest.maxLevel || regionalURLs.has(`${face}/${level}/${x}/${y}`);
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
  const ready = new Map<string, RecordEntry>(),
    pending = new Map<string, Pending>(),
    failed = new Set<string>(),
    attempts = new Map<string, number>();
  const free = Array.from({ length: residentLimit }, (_, i) => i + 1).reverse();
  let wanted = new Map<string, RecordEntry>(),
    prefetch = new Map<string, RecordEntry>();
  let frame = 0,
    disposed = false,
    qualityCap = manifest.maxLevel,
    animating = false;
  let previousOrigin: number[] | undefined,
    previousTime = 0,
    motionAt = -Infinity,
    dx = 0,
    dy = 0,
    dz = 0,
    zooming = false;
  let prefetchHits = 0,
    visibleLoads = 0,
    speculativeLoads = 0;
  const edge = new Float64Array(3);
  const key = (face: number, level: number, x: number, y: number) => `${face}/${level}/${x}/${y}`;
  const entry = (
    face: number,
    level: number,
    x: number,
    y: number,
    priority: number,
  ): RecordEntry => ({
    key: key(face, level, x, y),
    face,
    level,
    x,
    y,
    priority,
    slot: 0,
    used: frame,
  });
  const desired = (id: string) => wanted.has(id) || prefetch.has(id);
  function allocate(speculative: boolean): number | undefined {
    if (free.length) return free.pop();
    let oldest: RecordEntry | undefined;
    for (const candidate of ready.values()) {
      if (wanted.has(candidate.key) || (speculative && prefetch.has(candidate.key))) continue;
      if (!oldest || candidate.used < oldest.used) oldest = candidate;
    }
    if (!oldest) return undefined;
    ready.delete(oldest.key);
    return oldest.slot;
  }
  function pump(): void {
    if (disposed) return;
    const missing = [...wanted.values()].filter((e) => !ready.has(e.key) && !failed.has(e.key));
    const queue = missing.sort(
      (a, b) => (b.level === 0 ? 1 : 0) - (a.level === 0 ? 1 : 0) || b.priority - a.priority,
    );
    if (!missing.length)
      queue.push(...[...prefetch.values()].sort((a, b) => b.priority - a.priority));
    for (const item of queue) {
      if (pending.size >= 4) break;
      if (ready.has(item.key) || pending.has(item.key) || failed.has(item.key)) continue;
      const speculative = !wanted.has(item.key);
      if (speculative && [...pending.values()].some((p) => p.speculative)) continue;
      if (item.level > 0 && !speculative) {
        const parent = key(item.face, item.level - 1, item.x >> 1, item.y >> 1);
        if (wanted.has(parent) && !ready.has(parent) && !failed.has(parent)) continue;
      }
      const controller = new AbortController();
      pending.set(item.key, { controller, speculative });
      const relative = manifest.addressing.template
        .replace("{face}", String(item.face))
        .replace("{level}", String(item.level))
        .replace("{x}", String(item.x))
        .replace("{y}", String(item.y));
      void (regionalLoaders.get(item.key) ?? baseLoader)(
        regionalURLs.get(item.key) ?? new URL(relative, manifestURL).href,
        controller.signal,
      )
        .then((data) => {
          if (disposed || controller.signal.aborted || !desired(item.key)) return;
          if (data.length !== layerBytes)
            throw new Error("Tile image dimensions do not match manifest.");
          const slot = allocate(!wanted.has(item.key));
          if (slot === undefined) return;
          pixels.set(data, slot * layerBytes);
          texture.addLayerUpdate(slot);
          texture.needsUpdate = true;
          ready.set(item.key, { ...item, slot, used: frame });
          attempts.delete(item.key);
          if (speculative) speculativeLoads++;
          else visibleLoads++;
        })
        .catch((error) => {
          if (disposed || !desired(item.key) || controller.signal.aborted) return;
          const tries = (attempts.get(item.key) ?? 0) + 1;
          attempts.set(item.key, tries);
          // shortcut: three failures stick for the session, raise the cap if a longer blip should recover
          if (tries < 3) return;
          failed.add(item.key);
          console.warn("[Globes] Imagery tile failed", item.key, error);
        })
        .finally(() => {
          pending.delete(item.key);
          if (!disposed) {
            onChange();
            pump();
          }
        });
    }
  }
  function writeUV(
    i: number,
    image: RecordEntry | undefined,
    instances: TileInstances,
    offset: number,
  ): void {
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
  // Lower the finest level until the visible set fits in the resident slots.
  function collectWanted(instances: TileInstances, priorities: number[]): void {
    qualityCap = imageryMaxLevel;
    while (true) {
      wanted = new Map();
      for (let f = 0; f < 6; f++) {
        const root = entry(f, 0, 0, 0, 1e20);
        wanted.set(root.key, root);
      }
      for (let level = 1; level <= qualityCap && wanted.size <= residentLimit; level++) {
        for (let i = 0; i < instances.count; i++) {
          const j = i * 4,
            terrainLevel = Math.round(-Math.log2(instances.faceUVs[j + 2]));
          if (level > terrainLevel) continue;
          const n = 2 ** level,
            tile = entry(
              instances.faces[i],
              level,
              Math.floor(instances.faceUVs[j] * n),
              Math.floor(instances.faceUVs[j + 1] * n),
              priorities[i],
            );
          if (!available(tile.face, tile.level, tile.x, tile.y)) continue;
          const old = wanted.get(tile.key);
          if (old) old.priority += tile.priority;
          else wanted.set(tile.key, tile);
          if (wanted.size > residentLimit) break;
        }
      }
      if (wanted.size <= residentLimit) break;
      qualityCap--;
    }
    // The uniform cap keeps every visible leaf covered. Spare slots, and slots
    // taken from the least important tiles, keep the ground under the camera
    // and the screen center at their own terrain level when the view tilts.
    const uniformCoverage = new Set(wanted.keys());
    const deepen = (face: number, level: number, x: number, y: number, priority: number) => {
      if (level > imageryMaxLevel || !available(face, level, x, y)) return true;
      const tile = entry(face, level, x, y, priority);
      const old = wanted.get(tile.key);
      if (old) {
        old.priority = Math.max(old.priority, priority);
        return true;
      }
      if (wanted.size >= residentLimit) {
        let worstId = "";
        let worst = priority;
        for (const [id, resident] of wanted) {
          if (
            uniformCoverage.has(id) ||
            resident.level === 0 ||
            resident.priority >= 1e17 ||
            resident.priority >= worst
          )
            continue;
          // A refinement cannot evict the parent still needed by its children.
          let hasChild = false;
          for (let q = 0; q < 4; q++)
            hasChild ||= wanted.has(
              key(
                resident.face,
                resident.level + 1,
                resident.x * 2 + (q & 1),
                resident.y * 2 + (q >> 1),
              ),
            );
          if (hasChild) continue;
          worst = resident.priority;
          worstId = id;
        }
        if (!worstId) return false;
        wanted.delete(worstId);
      }
      wanted.set(tile.key, tile);
      return true;
    };
    const origin = instances.origin;
    if (Math.hypot(origin[0], origin[1], origin[2]) > 0) {
      const face = dominantFace(origin[0], origin[1], origin[2]);
      const [u, v] = cameraFaceUV(face, origin[0], origin[1], origin[2]);
      for (let level = qualityCap + 1; level <= imageryMaxLevel; level++) {
        const n = 2 ** level;
        if (!deepen(face, level, Math.floor(u * n), Math.floor(v * n), 1e18)) break;
      }
    }
    for (const i of priorities
      .map((_, index) => index)
      .sort((a, b) => priorities[b] - priorities[a])) {
      const j = i * 4,
        terrainLevel = Math.min(imageryMaxLevel, Math.round(-Math.log2(instances.faceUVs[j + 2]))),
        face = instances.faces[i];
      for (let level = qualityCap + 1; level <= terrainLevel; level++) {
        const n = 2 ** level;
        if (
          !deepen(
            face,
            level,
            Math.floor(instances.faceUVs[j] * n),
            Math.floor(instances.faceUVs[j + 1] * n),
            priorities[i],
          )
        )
          break;
      }
    }
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
  function speculate(
    face: number,
    level: number,
    x: number,
    y: number,
    priority: number,
    spare: number,
  ): void {
    const n = 2 ** level;
    // Cross a cube edge by projecting the candidate center onto its dominant face.
    if (x < 0 || y < 0 || x >= n || y >= n) {
      const u = (x + 0.5) / n - 0.5,
        v = (y + 0.5) / n - 0.5;
      faceToWorld(face, u, v, 0.5, edge);
      face = dominantFace(edge[0], edge[1], edge[2]);
      const uv = cameraFaceUV(face, edge[0], edge[1], edge[2]);
      x = Math.min(n - 1, Math.max(0, Math.floor(uv[0] * n)));
      y = Math.min(n - 1, Math.max(0, Math.floor(uv[1] * n)));
    }
    if (!available(face, level, x, y)) return;
    const tile = entry(face, level, x, y, priority);
    if (!wanted.has(tile.key) && !prefetch.has(tile.key) && prefetch.size < spare)
      prefetch.set(tile.key, tile);
  }
  function prefetchAround(
    instances: TileInstances,
    priorities: number[],
    spare: number,
    moving: boolean,
  ): void {
    const origin = instances.origin;
    for (const i of priorities
      .map((_, index) => index)
      .sort((a, b) => priorities[b] - priorities[a])) {
      const j = i * 4,
        level = Math.min(qualityCap, Math.round(-Math.log2(instances.faceUVs[j + 2]))),
        face = instances.faces[i],
        n = 2 ** level;
      const x = Math.floor(instances.faceUVs[j] * n),
        y = Math.floor(instances.faceUVs[j + 1] * n);
      if (moving) {
        const here = cameraFaceUV(face, origin[0], origin[1], origin[2]);
        const ahead = cameraFaceUV(face, origin[0] + dx, origin[1] + dy, origin[2] + dz);
        const sx = Math.sign(ahead[0] - here[0]),
          sy = Math.sign(ahead[1] - here[1]);
        if (sx) speculate(face, level, x + sx, y, priorities[i], spare);
        if (sy) speculate(face, level, x, y + sy, priorities[i], spare);
        if (zooming && level < imageryMaxLevel)
          for (let q = 0; q < 4; q++)
            speculate(face, level + 1, x * 2 + (q & 1), y * 2 + (q >> 1), priorities[i], spare);
      } else {
        speculate(face, level, x + 1, y, priorities[i], spare);
        speculate(face, level, x - 1, y, priorities[i], spare);
        speculate(face, level, x, y + 1, priorities[i], spare);
        speculate(face, level, x, y - 1, priorities[i], spare);
      }
      if (prefetch.size >= spare) break;
    }
  }
  function writeBindings(instances: TileInstances, now: number, fadeMs: number): void {
    for (let i = 0; i < instances.count; i++) {
      const j = i * 4,
        face = instances.faces[i],
        limit = Math.min(imageryMaxLevel, Math.round(-Math.log2(instances.faceUVs[j + 2])));
      let best: RecordEntry | undefined,
        parent: RecordEntry | undefined,
        blend = 1;
      for (let level = 0; level <= limit; level++) {
        const n = 2 ** level,
          resident = ready.get(
            key(
              face,
              level,
              Math.floor(instances.faceUVs[j] * n),
              Math.floor(instances.faceUVs[j + 1] * n),
            ),
          );
        if (!resident) continue;
        resident.used = frame;
        if (best && blend < 1) break; // Finish the parent fade before revealing its child.
        parent = best;
        best = resident;
        resident.fadeStart ??= now;
        blend = fadeMs === 0 ? 1 : Math.min(1, Math.max(0, (now - resident.fadeStart) / fadeMs));
      }
      animating ||= best !== undefined && blend < 1;
      const row = i * IMAGERY_STRIDE;
      bindings.data[row] = best?.slot ?? 0;
      bindings.data[row + 1] = parent?.slot ?? 0;
      writeUV(i, best, instances, 2);
      writeUV(i, parent, instances, 6);
      bindings.data[row + 10] = blend * blend * (3 - 2 * blend);
    }
  }
  function update(instances: TileInstances, view?: StreamingView): void {
    if (disposed) return;
    if (instances.count > terrainCapacity)
      throw new RangeError("Imagery terrain capacity exceeded.");
    frame++;
    animating = false;
    const now = view?.now ?? performance.now();
    const fadeMs = view ? Math.max(0, options.fadeMs ?? 250) : 0;
    const priorities = Array.from({ length: instances.count }, (_, i) =>
      screenImportance(instances, i, view),
    );
    collectWanted(instances, priorities);
    for (const id of wanted.keys()) if (prefetch.has(id) && ready.has(id)) prefetchHits++;
    prefetch = new Map();
    const spare = Math.max(0, Math.min(options.prefetchLimit ?? 12, residentLimit - wanted.size));
    const moving = trackMotion(instances.origin, view, now);
    if (view && spare > 0) prefetchAround(instances, priorities, spare, moving);
    for (const id of failed) if (!desired(id)) failed.delete(id);
    for (const id of attempts.keys()) if (!desired(id)) attempts.delete(id);
    const visibleMissing = [...wanted.keys()].some((id) => !ready.has(id) && !failed.has(id));
    for (const [id, request] of pending)
      if (!desired(id) || (request.speculative && visibleMissing)) request.controller.abort();
    writeBindings(instances, now, fadeMs);
    bindings.revision++;
    pump();
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
      onChange();
    },
    texture,
    bindings,
    update,
    needsFrame: () => animating,
    stats: () => ({
      resident: ready.size,
      loading: pending.size,
      wanted: wanted.size,
      prefetch: prefetch.size,
      prefetchHits,
      visibleLoads,
      speculativeLoads,
      qualityCap,
    }),
    status: () =>
      `Imagery levels 0–${manifest.maxLevel}${regionCount ? ` + regional layers (${regionCount}, to level ${imageryMaxLevel})` : ""}${qualityCap < imageryMaxLevel ? ` (cache cap ${qualityCap})` : ""} · ${ready.size} images resident · ${pending.size} loading · ${prefetchHits} prefetch hits${failed.size ? ` · ${failed.size} unavailable` : ""}`,
    dispose() {
      disposed = true;
      for (const p of pending.values()) p.controller.abort();
      pending.clear();
      ready.clear();
      texture.dispose();
    },
  };
}
export type ImageryCache = ReturnType<typeof createImageryCache>;
