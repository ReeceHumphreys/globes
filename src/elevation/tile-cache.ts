import { createShadowHeightIndex } from "../rendering/shadow-height-index.ts";
import { instanceAddress, instanceLevel, type TileInstances } from "../rendering/tile-instances.ts";
import { datasetLevel, rootMaxLevel, rootPoint, rootWidth, tileKey } from "../tiles/roots.ts";
import { addressAt, DEFAULT_FADE_MS, type TileAddress } from "../tiles/resident-tiles.ts";
import { createTileStream } from "../tiles/tile-stream.ts";
import { HEIGHT_RANGE, HEIGHT_STRIDE } from "../rendering/binding-row.ts";
import type { StreamingView } from "../imagery/priority.ts";
import { heightMeters, sampleTile, zeroHeightBytes } from "./tiles.ts";
import type { HeightSource } from "./source.ts";

/** Decoded values, and the largest half-sample step along each axis. */
interface HeightPayload {
  values: Uint16Array;
  stepX: number;
  stepY: number;
}

/** Resident height tiles from any {@link HeightSource}, bound for the terrain shaders. */
export function createHeightTileCache(
  source: HeightSource,
  capacity: number,
  onChange: () => void,
  residentLimit = 64,
  {
    fadeMs = DEFAULT_FADE_MS,
    onError = console.warn,
  }: {
    fadeMs?: number;
    onError?(error: unknown): void;
  } = {},
) {
  const { tileSize, gutter } = source;
  if (
    !Number.isInteger(tileSize) ||
    tileSize < 16 ||
    tileSize > 256 ||
    !Number.isInteger(gutter) ||
    gutter < 2 ||
    gutter > 8
  )
    throw new RangeError("Height source tile size must be 16..256 with a 2..8 gutter.");
  const rangeMemo = new Map<string, [number, number]>();
  const stream = createTileStream<HeightPayload, HeightPayload>({
    tileSize,
    gutter,
    texels: "height",
    // Slot zero is the zero-meter surface, not the stored value zero.
    empty: zeroHeightBytes(source),
    flipV: true,
    stride: HEIGHT_STRIDE,
    capacity,
    slots: residentLimit,
    label: "Height",
    fadeMs,
    maxLevel: () => source.maxLevel,
    available: (root, level, x, y) => source.bounds({ root, level, x, y }) !== undefined,
    coverGround: true,
    busy: () => source.pending?.() ?? 0,
    async load(address, signal) {
      const values = await source.load(address, signal);
      if (values.length !== width * width) throw new Error("Height tile size mismatch.");
      // Largest half-sample step, used to bound sub-tile ranges around the center.
      let stepX = 0,
        stepY = 0;
      for (let y = 0; y < width; y++)
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (x + 1 < width) stepX = Math.max(stepX, Math.abs(values[i + 1] - values[i]) * 0.5);
          if (y + 1 < width) stepY = Math.max(stepY, Math.abs(values[i + width] - values[i]) * 0.5);
        }
      return { values, stepX, stepY };
    },
    // The texture holds little-endian bytes; every WebGPU platform is little-endian.
    bytes: ({ values }) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    keep(payload) {
      rangeMemo.clear();
      return payload;
    },
    onChange,
    onError,
  });
  const { tiles, texture, bindings, slotVersions, width } = stream;
  const shadowIndex = createShadowHeightIndex(residentLimit, source.maxLevel);
  let drawing: TileInstances | undefined;
  let disposed = false;
  const listingChanged = () => {
    if (disposed) return;
    rangeMemo.clear();
    tiles.invalidate();
    tiles.pump();
    onChange();
  };
  type Resident = NonNullable<ReturnType<typeof tiles.get>>;
  function sample(r: Resident | undefined, u: number, v: number) {
    if (!r) return 0;
    const n = 2 ** r.level;
    return sampleTile(
      r.values,
      width,
      gutter + (u * n - r.x) * tileSize - 0.5,
      gutter + (1 - (v * n - r.y)) * tileSize - 0.5,
      source,
    );
  }
  /** Tell a lazily listed source what is in view, and the deepest tile under the camera. */
  function focus(instances: TileInstances) {
    if (!source.focus) return;
    const [root, u, v] = rootPoint(instances.origin[0], instances.origin[1], instances.origin[2]);
    const view: TileAddress[] = [addressAt(root, rootMaxLevel(root, source.maxLevel), u, v)];
    for (let i = 0; i < instances.count; i++) view.push(instanceAddress(instances, i));
    source.focus(view, listingChanged);
  }
  function update(instances: TileInstances, view?: StreamingView) {
    if (disposed) return;
    drawing = instances;
    focus(instances);
    const previousCap = tiles.cap;
    stream.plan(instances, view);
    if (tiles.cap !== previousCap) rangeMemo.clear();
    // Start late network arrivals on the frame that reveals them, not at the
    // stale clock from their request. Activate coarse offscreen roots too so
    // shadow rays have the same smoothly arriving global fallback.
    if (tiles.startRootFades()) stream.animate();
    noteFade();
    stream.write(instances, (i, row) => {
      const { root, level, x, y } = instanceAddress(instances, i);
      rangeForTile(root, level, x, y, bindingRange);
      bindings.data[row + HEIGHT_RANGE] = bindingRange[1] - bindingRange[0];
    });
    const [root, u, v] = rootPoint(instances.origin[0], instances.origin[1], instances.origin[2]);
    const ground = tiles.pair(root, drawLevelAt(root, u, v), u, v, true);
    shadowIndex.write(tiles.resident(), stream.clock, stream.fadeMs);
    if (ground.best && ground.blend < 1) stream.animate();
    stream.pump();
  }
  function drawLevelAt(root: number, u: number, v: number): number {
    if (drawing)
      for (let i = 0; i < drawing.count; i++) {
        const j = i * 3;
        if (
          drawing.roots[i] === root &&
          u >= drawing.rootUVs[j] &&
          u <= drawing.rootUVs[j] + drawing.rootUVs[j + 2] &&
          v >= drawing.rootUVs[j + 1] &&
          v <= drawing.rootUVs[j + 1] + drawing.rootUVs[j + 2]
        )
          return instanceLevel(drawing, i);
      }
    return rootMaxLevel(root, source.maxLevel);
  }
  /** `sampleDirection`, plus the dataset level and sample spacing in radians of the finest tile in it. */
  function sampleSource(x: number, y: number, z: number) {
    const [root, u, v] = rootPoint(x, y, z),
      p = tiles.pair(root, drawLevelAt(root, u, v), u, v),
      tile = p.blend > 0 ? p.best : p.parent;
    return {
      height: sample(p.parent, u, v) * (1 - p.blend) + sample(p.best, u, v) * p.blend,
      level: tile && datasetLevel(root, tile.level),
      // North-south spacing; east-west narrows with latitude on the geographic roots.
      angle: tile && rootWidth(root) / 2 ** tile.level / tileSize,
    };
  }
  function sampleDirection(x: number, y: number, z: number) {
    const [root, u, v] = rootPoint(x, y, z),
      p = tiles.pair(root, drawLevelAt(root, u, v), u, v);
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
      const tile = source.bounds(r);
      if (tile) {
        out[0] = tile.min - 0.5;
        out[1] = tile.max + 0.5;
        return;
      }
    }
    const factor = 2 ** (l - r.level),
      px = gutter + (x / factor - r.x) * tileSize - 0.5,
      py = gutter + (1 - ((y + 1) / factor - r.y)) * tileSize - 0.5,
      span = tileSize / factor;
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
    const center = sampleTile(r.values, width, px + span * 0.5, py + span * 0.5, source),
      deviation = (r.stepX + r.stepY) * span * 0.5;
    out[0] = Math.max(heightMeters(lo, source), center - deviation) - 0.5;
    out[1] = Math.min(heightMeters(hi, source), center + deviation) + 0.5;
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
  function rangeForTile(root: number, l: number, x: number, y: number, out: Float64Array) {
    const id = tileKey(root, l, x, y),
      memo = rangeMemo.get(id);
    if (memo) {
      out[0] = memo[0];
      out[1] = memo[1];
      return;
    }
    const u = (x + 0.5) / 2 ** l,
      v = (y + 0.5) / 2 ** l;
    let info = source.bounds({ root, level: 0, x: 0, y: 0 })!,
      record: Resident | undefined,
      selectedLevel = 0;
    for (let level = 0; level <= Math.min(l, rootMaxLevel(root, source.maxLevel)); level++) {
      const address = addressAt(root, level, u, v),
        bounds = source.bounds(address);
      if (bounds) {
        info = bounds;
        record = tiles.get(tileKey(root, level, address.x, address.y));
        selectedLevel = level;
      }
    }
    // Unlisted finer tiles may reach past what the resident samples show.
    if (record && l > selectedLevel && !info.partial) recordRange(record, l, x, y, out);
    else {
      out[0] = info.lower;
      out[1] = info.upper;
    }
    const p = tiles.pair(root, l, u, v);
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
      return stream.revision + shadowIndex.revision;
    },
    texture,
    bindings,
    source,
    update,
    sampleDirection,
    sampleSource,
    rangeForTile,
    advance(now: number) {
      stream.advance(now);
      noteFade();
    },
    needsFrame: stream.needsFrame,
    /** Every wanted tile and listing has arrived or failed, and no fade is running. */
    settled: stream.settled,
    stats: () => {
      const { resident, loading, wanted, failed, cap } = tiles.stats();
      return { resident, loading: loading + (source.pending?.() ?? 0), wanted, failed, cap };
    },
    status: () => {
      const { resident, loading, failed } = tiles.stats();
      const busy = loading + (source.pending?.() ?? 0);
      return `Tiled elevation · ${resident}/${residentLimit} resident · ${busy} loading${failed ? ` · ${failed} unavailable` : ""}`;
    },
    dispose() {
      disposed = true;
      stream.dispose();
      source.dispose?.();
      rangeMemo.clear();
      shadowIndex.dispose();
    },
  };
}
export type HeightTileCache = ReturnType<typeof createHeightTileCache>;
