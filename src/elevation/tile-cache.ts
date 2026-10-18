import { createTileBytesLoader } from "../tiles/tile-source.ts";
import { createShadowHeightIndex } from "../rendering/shadow-height-index.ts";
import {
  DataArrayTexture,
  RGFormat,
  UnsignedByteType,
  NearestFilter,
  NoColorSpace,
} from "three/webgpu";
import type { TileInstances } from "../rendering/tile-instances.ts";
import { screenImportance, type StreamingView } from "../imagery/priority.ts";
import {
  HEIGHT_STRIDE,
  parseHeightPage,
  decodeHeightTile,
  sampleTile,
  facePoint,
  type HeightTileManifest,
  type HeightTileLoader,
} from "./tiles.ts";

type RecordEntry = {
  key: string;
  face: number;
  level: number;
  x: number;
  y: number;
  slot: number;
  values: Uint16Array;
  used: number;
  stepX: number;
  stepY: number;
  start?: number;
};
type Wanted = { face: number; level: number; x: number; y: number; priority: number };
export function createHeightTileCache(
  manifest: HeightTileManifest,
  url: string,
  capacity: number,
  onChange: () => void,
  load: HeightTileLoader = createTileBytesLoader(manifest.storage, url),
  residentLimit = 64,
  fadeMs = 300,
) {
  if (!Number.isInteger(residentLimit) || residentLimit < 6 || residentLimit > 255)
    throw new RangeError("Height residency must be 6..255.");
  const width = manifest.tileSize + 2 * manifest.gutter,
    layerBytes = width * width * 2;
  const bytes = new Uint8Array(layerBytes * (residentLimit + 1));
  // Slot zero is the zero-meter sphere, not the uint16 value zero (-10 km).
  for (let i = 0; i < layerBytes; i += 2) {
    bytes[i] = 32;
    bytes[i + 1] = 78;
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
  const metadata = { ...manifest.tiles };
  const loadedPages = new Map<string, { keys: string[]; used: number }>(),
    pendingPages = new Map<string, AbortController>(),
    failedPages = new Set<string>();
  let wantedPages = new Set<string>();
  let drawing: TileInstances | undefined;
  const ready = new Map<string, RecordEntry>(),
    pending = new Map<string, AbortController>(),
    failed = new Set<string>(),
    attempts = new Map<string, number>();
  let wanted = new Map<string, Wanted>(),
    clock = 0,
    frame = 0,
    cap = manifest.maxLevel,
    disposed = false,
    animating = false;
  const free = Array.from({ length: residentLimit }, (_, i) => i + 1).reverse();
  const key = (f: number, l: number, x: number, y: number) => `${f}/${l}/${x}/${y}`;
  function idAt(f: number, l: number, u: number, v: number) {
    const n = 2 ** l;
    return key(
      f,
      l,
      Math.min(n - 1, Math.max(0, Math.floor(u * n))),
      Math.min(n - 1, Math.max(0, Math.floor(v * n))),
    );
  }
  function pair(f: number, l: number, u: number, v: number, activate = false) {
    let best: RecordEntry | undefined,
      parent: RecordEntry | undefined,
      blend = 1;
    for (let level = 0; level <= l; level++) {
      const r = ready.get(idAt(f, level, u, v));
      if (!r || !metadata[r.key]) continue;
      if (best && blend < 1) break;
      parent = best;
      best = r;
      if (activate) {
        r.start ??= clock;
        r.used = frame;
      }
      const t =
        r.start === undefined
          ? 0
          : fadeMs === 0
            ? 1
            : Math.max(0, Math.min(1, (clock - r.start) / fadeMs));
      blend = t * t * (3 - 2 * t);
    }
    return { best, parent, blend };
  }
  function sample(r: RecordEntry | undefined, u: number, v: number) {
    if (!r) return 0;
    const n = 2 ** r.level;
    return sampleTile(
      r.values,
      width,
      manifest.gutter + (u * n - r.x) * manifest.tileSize - 0.5,
      manifest.gutter + (1 - (v * n - r.y)) * manifest.tileSize - 0.5,
    );
  }
  function allocate() {
    if (free.length) return free.pop();
    let oldest: RecordEntry | undefined;
    for (const r of ready.values())
      if (!wanted.has(r.key) && (!oldest || r.used < oldest.used)) oldest = r;
    if (oldest) {
      ready.delete(oldest.key);
      return oldest.slot;
    }
    return undefined;
  }
  function pump() {
    if (disposed) return;
    const queue = [...wanted.entries()]
      .filter(([k]) => !ready.has(k) && !failed.has(k))
      .sort((a, b) => a[1].level - b[1].level || b[1].priority - a[1].priority);
    for (const [id, a] of queue) {
      if (pending.size + pendingPages.size >= 4) break;
      if (pending.has(id)) continue;
      const parent = key(a.face, a.level - 1, a.x >> 1, a.y >> 1);
      if (a.level > 0 && wanted.has(parent) && !ready.has(parent) && !failed.has(parent)) continue;
      const controller = new AbortController();
      pending.set(id, controller);
      const info = metadata[id];
      void load(new URL(info.path, url).href, controller.signal)
        .then(async (data) => {
          if (disposed || controller.signal.aborted || !wanted.has(id)) return;
          const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
          if (
            [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") !==
            info.sha256
          )
            throw new Error("Height tile checksum mismatch.");
          if (disposed || controller.signal.aborted || !wanted.has(id)) return;
          const values = decodeHeightTile(data, info, width),
            slot = allocate();
          if (slot === undefined) return;
          let stepX = 0,
            stepY = 0;
          for (let y = 0; y < width; y++)
            for (let x = 0; x < width; x++) {
              const i = y * width + x;
              if (x + 1 < width) stepX = Math.max(stepX, Math.abs(values[i + 1] - values[i]) * 0.5);
              if (y + 1 < width)
                stepY = Math.max(stepY, Math.abs(values[i + width] - values[i]) * 0.5);
            }
          bytes.set(data, slot * layerBytes);
          slotVersions[slot]++;
          contentRevision++;
          texture.addLayerUpdate(slot);
          texture.needsUpdate = true;
          rangeMemo.clear();
          ready.set(id, {
            ...a,
            key: id,
            slot,
            values,
            used: frame,
            stepX,
            stepY,
          });
          attempts.delete(id);
        })
        .catch((error) => {
          if (disposed || controller.signal.aborted || !wanted.has(id)) return;
          const tries = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, tries);
          // shortcut: three failures stick for the session, raise the cap if a longer blip should recover
          if (tries < 3) return;
          failed.add(id);
          console.warn("[Globes] Height tile failed", id, error);
        })
        .finally(() => {
          pending.delete(id);
          if (!disposed) {
            onChange();
            pump();
            pumpPages();
          }
        });
    }
  }
  function pageAt(f: number, u: number, v: number) {
    return manifest.pages ? idAt(f, manifest.pageLevel!, u, v) : undefined;
  }
  function pumpPages() {
    if (disposed) return;
    for (const id of wantedPages) {
      if (pending.size + pendingPages.size >= 4) break;
      if (loadedPages.has(id) || pendingPages.has(id) || failedPages.has(id)) continue;
      const page = manifest.pages![id],
        controller = new AbortController();
      pendingPages.set(id, controller);
      void fetch(new URL(page.path, url), { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("Height metadata page HTTP " + response.status);
          const bytes = await response.arrayBuffer(),
            digest = await crypto.subtle.digest("SHA-256", bytes);
          if (
            [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") !==
            page.sha256
          )
            throw new Error("Height metadata page checksum mismatch.");
          if (disposed || controller.signal.aborted || !wantedPages.has(id)) return;
          const entries = parseHeightPage(
            JSON.parse(new TextDecoder().decode(bytes)),
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
          loadedPages.set(id, { keys: Object.keys(entries), used: frame });
        })
        .catch((error) => {
          if (!disposed && !controller.signal.aborted) {
            failedPages.add(id);
            console.warn("[Globes] Height metadata page failed", id, error);
          }
        })
        .finally(() => {
          pendingPages.delete(id);
          if (!disposed) {
            onChange();
            pump();
            pumpPages();
          }
        });
    }
  }
  function writeUV(
    row: number,
    r: RecordEntry | undefined,
    offset: number,
    instances: TileInstances,
  ) {
    const data = bindings.data,
      index = row * HEIGHT_STRIDE + offset;
    if (!r) {
      data.fill(0, index, index + 4);
      return;
    }
    const scale = manifest.tileSize / width,
      n = 2 ** r.level,
      pad = manifest.gutter / width;
    const j = row * 4;
    data.set(
      [
        pad + (instances.faceUVs[j] * n - r.x) * scale,
        pad + (1 - (instances.faceUVs[j + 1] * n - r.y)) * scale,
        n * instances.faceUVs[j + 2] * scale,
        -n * instances.faceUVs[j + 3] * scale,
      ],
      index,
    );
  }
  function update(instances: TileInstances, view?: StreamingView) {
    if (disposed) return;
    if (instances.count > capacity) throw new RangeError("Height instance capacity exceeded.");
    drawing = instances;
    frame++;
    wantedPages = new Set();
    function wantPage(f: number, u: number, v: number) {
      const id = pageAt(f, u, v);
      if (id && manifest.pages![id] && wantedPages.size < 16) {
        wantedPages.add(id);
        const page = loadedPages.get(id);
        if (page) page.used = frame;
      }
    }
    const cameraUV = facePoint(instances.origin[0], instances.origin[1], instances.origin[2]);
    wantPage(...cameraUV);
    for (let i = 0; i < instances.count; i++) {
      const j = i * 4;
      if (-Math.log2(instances.faceUVs[j + 2]) > (manifest.pageLevel ?? 20))
        wantPage(
          instances.faces[i],
          instances.faceUVs[j] + instances.faceUVs[j + 2] / 2,
          instances.faceUVs[j + 1] + instances.faceUVs[j + 3] / 2,
        );
    }
    for (const [id, c] of pendingPages) if (!wantedPages.has(id)) c.abort();
    for (const id of failedPages) if (!wantedPages.has(id)) failedPages.delete(id);
    if (view) clock = view.now;
    animating = false;
    // Start late network arrivals on the frame that reveals them, not at the
    // stale clock from their request. Activate coarse offscreen roots too so
    // shadow rays have the same smoothly arriving global fallback.
    for (let f = 0; f < 6; f++) {
      const root = ready.get(key(f, 0, 0, 0));
      if (root) {
        root.start ??= clock;
        animating ||= clock - root.start < fadeMs;
      }
    }
    noteFade();
    const previousCap = cap;
    cap = manifest.maxLevel;
    while (true) {
      wanted = new Map();
      for (let f = 0; f < 6; f++)
        wanted.set(key(f, 0, 0, 0), { face: f, level: 0, x: 0, y: 0, priority: 1e20 });
      const add = (f: number, l: number, u: number, v: number, priority: number) => {
        const id = idAt(f, l, u, v);
        if (!metadata[id]) return;
        const [face, level, x, y] = id.split("/").map(Number);
        const old = wanted.get(id);
        if (old) old.priority += priority;
        else wanted.set(id, { face, level, x, y, priority });
      };
      for (let i = 0; i < instances.count && wanted.size <= residentLimit; i++) {
        const j = i * 4,
          level = Math.min(cap, Math.round(-Math.log2(instances.faceUVs[j + 2]))),
          u = instances.faceUVs[j] + instances.faceUVs[j + 2] * 0.5,
          v = instances.faceUVs[j + 1] + instances.faceUVs[j + 3] * 0.5;
        for (let l = 1; l <= level; l++)
          add(instances.faces[i], l, u, v, screenImportance(instances, i, view));
      }
      // Ground directly under the camera must also be known when looking at the horizon.
      const [f, u, v] = facePoint(instances.origin[0], instances.origin[1], instances.origin[2]);
      for (let l = 1; l <= cap; l++) add(f, l, u, v, 1e18);
      if (wanted.size <= residentLimit) break;
      cap--;
    }
    // Same spare-slot rule as imagery: a tilted horizon must not drop the
    // height tiles under the camera or at the screen center.
    const uniformCoverage = new Set(wanted.keys());
    const deepen = (f: number, u: number, v: number, level: number, priority: number) => {
      if (level > manifest.maxLevel) return false;
      const id = idAt(f, level, u, v);
      if (!metadata[id]) return true;
      const old = wanted.get(id);
      if (old) {
        old.priority = Math.max(old.priority, priority);
        return true;
      }
      if (wanted.size >= residentLimit) {
        let worstId = "";
        let worst = priority;
        for (const [key, tile] of wanted) {
          if (
            uniformCoverage.has(key) ||
            tile.level === 0 ||
            tile.priority >= 1e17 ||
            tile.priority >= worst
          )
            continue;
          let hasChild = false;
          for (let q = 0; q < 4; q++)
            hasChild ||= wanted.has(
              `${tile.face}/${tile.level + 1}/${tile.x * 2 + (q & 1)}/${tile.y * 2 + (q >> 1)}`,
            );
          if (hasChild) continue;
          worst = tile.priority;
          worstId = key;
        }
        if (!worstId) return false;
        wanted.delete(worstId);
      }
      const [face, heightLevel, x, y] = id.split("/").map(Number);
      wanted.set(id, { face, level: heightLevel, x, y, priority });
      return true;
    };
    const [groundFace, groundU, groundV] = facePoint(
      instances.origin[0],
      instances.origin[1],
      instances.origin[2],
    );
    if (Math.hypot(instances.origin[0], instances.origin[1], instances.origin[2]) > 0)
      for (let level = cap + 1; level <= manifest.maxLevel; level++)
        if (!deepen(groundFace, groundU, groundV, level, 1e18)) break;
    for (const i of [...instances.faces.slice(0, instances.count).keys()].sort(
      (a, b) => screenImportance(instances, b, view) - screenImportance(instances, a, view),
    )) {
      const j = i * 4,
        terrainLevel = Math.round(-Math.log2(instances.faceUVs[j + 2])),
        u = instances.faceUVs[j] + instances.faceUVs[j + 2] * 0.5,
        v = instances.faceUVs[j + 1] + instances.faceUVs[j + 3] * 0.5;
      for (let level = cap + 1; level <= terrainLevel; level++)
        if (!deepen(instances.faces[i], u, v, level, screenImportance(instances, i, view))) break;
    }
    if (cap !== previousCap) rangeMemo.clear();
    for (const [id, c] of pending) if (!wanted.has(id)) c.abort();
    for (const id of failed) if (!wanted.has(id)) failed.delete(id);
    for (const id of attempts.keys()) if (!wanted.has(id)) attempts.delete(id);
    for (let i = 0; i < instances.count; i++) {
      const j = i * 4,
        u = instances.faceUVs[j] + instances.faceUVs[j + 2] * 0.5,
        v = instances.faceUVs[j + 1] + instances.faceUVs[j + 3] * 0.5;
      const p = pair(
          instances.faces[i],
          Math.round(-Math.log2(instances.faceUVs[j + 2])),
          u,
          v,
          true,
        ),
        row = i * HEIGHT_STRIDE;
      bindings.data[row] = p.best?.slot ?? 0;
      bindings.data[row + 1] = p.parent?.slot ?? 0;
      writeUV(i, p.best, 2, instances);
      writeUV(i, p.parent, 6, instances);
      bindings.data[row + 10] = p.blend;
      bindings.data[row + 11] = instances.faces[i];
      rangeForTile(
        instances.faces[i],
        Math.round(-Math.log2(instances.faceUVs[j + 2])),
        Math.round(instances.faceUVs[j] / instances.faceUVs[j + 2]),
        Math.round(instances.faceUVs[j + 1] / instances.faceUVs[j + 3]),
        bindingRange,
      );
      bindings.data[row + 12] = bindingRange[1] - bindingRange[0];
      animating ||= !!p.best && p.blend < 1;
    }
    const [f, u, v] = facePoint(instances.origin[0], instances.origin[1], instances.origin[2]);
    const ground = pair(f, drawLevelAt(f, u, v), u, v, true);
    shadowIndex.write(ready.values(), clock, fadeMs);
    animating ||= !!ground.best && ground.blend < 1;
    pump();
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
          return Math.round(-Math.log2(drawing.faceUVs[j + 2]));
      }
    return manifest.maxLevel;
  }
  function sampleDirection(x: number, y: number, z: number) {
    const [f, u, v] = facePoint(x, y, z),
      p = pair(f, drawLevelAt(f, u, v), u, v);
    return sample(p.parent, u, v) * (1 - p.blend) + sample(p.best, u, v) * p.blend;
  }
  function recordRange(
    r: RecordEntry | undefined,
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
    out[0] = Math.max(lo * 0.5 - 10000, center - deviation) - 0.5;
    out[1] = Math.min(hi * 0.5 - 10000, center + deviation) + 0.5;
  }
  const temp = new Float64Array(2);
  const bindingRange = new Float64Array(2);
  // The stored range includes the fading parent. It stays the same until that
  // fade ends, so intermediate frames keep the memory.
  let fadeOpen = false;
  function noteFade(): void {
    let still = false;
    if (fadeMs > 0)
      for (const record of ready.values())
        if (record.start !== undefined && clock - record.start < fadeMs) still = true;
    if (fadeOpen && !still) rangeMemo.clear();
    fadeOpen = still;
  }
  function rangeForTile(f: number, l: number, x: number, y: number, out: Float64Array) {
    const id = key(f, l, x, y),
      memo = rangeMemo.get(id);
    if (memo) {
      out[0] = memo[0];
      out[1] = memo[1];
      return;
    }
    const u = (x + 0.5) / 2 ** l,
      v = (y + 0.5) / 2 ** l;
    let info = metadata[key(f, 0, 0, 0)],
      record: RecordEntry | undefined,
      selectedLevel = 0;
    for (let level = 0; level <= Math.min(l, manifest.maxLevel); level++) {
      const id = idAt(f, level, u, v);
      if (metadata[id]) {
        info = metadata[id];
        record = ready.get(id);
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
    const p = pair(f, l, u, v);
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
      noteFade();
    },
    needsFrame: () => animating,
    stats: () => ({
      resident: ready.size,
      loading: pending.size + pendingPages.size,
      wanted: wanted.size,
      failed: failed.size + failedPages.size,
      cap,
      metadataPages: loadedPages.size,
    }),
    status: () =>
      `Tiled elevation · ${ready.size}/${residentLimit} resident · ${pending.size + pendingPages.size} loading${failed.size + failedPages.size ? ` · ${failed.size + failedPages.size} unavailable` : ""}`,
    dispose() {
      disposed = true;
      for (const c of pending.values()) c.abort();
      for (const c of pendingPages.values()) c.abort();
      pending.clear();
      pendingPages.clear();
      loadedPages.clear();
      rangeMemo.clear();
      ready.clear();
      texture.dispose();
      shadowIndex.dispose();
    },
  };
}
export type HeightTileCache = ReturnType<typeof createHeightTileCache>;
