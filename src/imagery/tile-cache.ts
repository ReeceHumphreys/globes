import type { ImagerySource } from "./source.ts";
import { instanceLevel, type TileInstances } from "../rendering/tile-instances.ts";
import type { StreamingView } from "./priority.ts";
import { isCap, rootDirection, rootMaxLevel, rootPoint, rootUV } from "../tiles/roots.ts";
import { addressAt } from "../tiles/resident-tiles.ts";
import { createTileStream } from "../tiles/tile-stream.ts";
import { IMAGERY_STRIDE } from "../rendering/binding-row.ts";

export interface ImageryBindings {
  data: Float32Array;
}
export function createImageryCache(
  source: ImagerySource,
  terrainCapacity: number,
  onChange: () => void,
  residentLimit = 128,
  options: { fadeMs?: number; prefetchLimit?: number; onError?(error: unknown): void } = {},
) {
  const stream = createTileStream<Uint8Array>({
    tileSize: source.tileSize,
    gutter: source.gutter,
    texels: "color",
    stride: IMAGERY_STRIDE,
    capacity: terrainCapacity,
    slots: residentLimit,
    label: "Imagery",
    fadeMs: options.fadeMs,
    maxLevel: () => source.maxLevel(),
    available: (root, level, x, y) => source.has({ root, level, x, y }),
    load: (tile, signal) => source.load(tile, signal),
    bytes: (data) => data,
    onChange,
    onError: options.onError,
  });
  const { tiles, texture, bindings } = stream;
  let disposed = false;
  let previousOrigin: number[] | undefined,
    previousTime = 0,
    motionAt = -Infinity,
    dx = 0,
    dy = 0,
    dz = 0,
    zooming = false;
  const edge = new Float64Array(3);
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
  function speculate(root: number, level: number, x: number, y: number, priority: number) {
    const n = 2 ** level;
    // Past a root's edge, find the candidate's center on the root that owns it. Levels
    // differ across the join, so speculation stops there.
    if (x < 0 || y < 0 || x >= n || y >= n) {
      rootDirection(root, (x + 0.5) / n, (y + 0.5) / n, edge);
      const [owner, u, v] = rootPoint(edge[0], edge[1], edge[2]);
      if (isCap(owner) !== isCap(root)) return;
      ({ root, x, y } = addressAt(owner, level, u, v));
    }
    tiles.prefetch(root, level, x, y, priority);
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
      const j = i * 3,
        root = instances.roots[i],
        level = Math.min(rootMaxLevel(root, tiles.cap), instanceLevel(instances, i)),
        deepest = rootMaxLevel(root, source.maxLevel()),
        n = 2 ** level,
        priority = priorities[i];
      const x = Math.floor(instances.rootUVs[j] * n),
        y = Math.floor(instances.rootUVs[j + 1] * n);
      const candidates: [number, number, number][] = [];
      if (moving) {
        const here = rootUV(root, origin[0], origin[1], origin[2]);
        const ahead = rootUV(root, origin[0] + dx, origin[1] + dy, origin[2] + dz);
        const sx = Math.sign(ahead[0] - here[0]),
          sy = Math.sign(ahead[1] - here[1]);
        if (sx) candidates.push([level, x + sx, y]);
        if (sy) candidates.push([level, x, y + sy]);
        if (zooming && level < deepest)
          for (let q = 0; q < 4; q++)
            candidates.push([level + 1, x * 2 + (q & 1), y * 2 + (q >> 1)]);
      } else
        candidates.push([level, x + 1, y], [level, x - 1, y], [level, x, y + 1], [level, x, y - 1]);
      for (const [l, cx, cy] of candidates)
        if (tiles.prefetchCount < spare) speculate(root, l, cx, cy, priority);
    }
  }
  function update(instances: TileInstances, view?: StreamingView): void {
    if (disposed) return;
    const now = view?.now ?? performance.now();
    const priorities = stream.plan(instances, view);
    const spare = Math.max(
      0,
      Math.min(options.prefetchLimit ?? 12, residentLimit - tiles.wantedCount),
    );
    const moving = trackMotion(instances.origin, view, now);
    if (view && spare > 0) prefetchAround(instances, priorities, spare, moving);
    stream.write(instances);
    stream.pump();
  }
  return {
    /** The source's tiles changed: replan from them. */
    refresh() {
      if (disposed) return;
      tiles.invalidate();
      onChange();
    },
    texture,
    bindings,
    update,
    needsFrame: stream.needsFrame,
    /** Every wanted tile has arrived or failed, and no fade is running. */
    settled: stream.settled,
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
      return `${source.describe()}${cap < source.maxLevel() ? ` (cache cap ${cap})` : ""} · ${resident} images resident · ${loading} loading · ${prefetchHits} prefetch hits${failed ? ` · ${failed} unavailable` : ""}`;
    },
    dispose() {
      disposed = true;
      stream.dispose();
    },
  };
}
export type ImageryCache = ReturnType<typeof createImageryCache>;
