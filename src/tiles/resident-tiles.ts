import { instanceCenter, instanceLevel, type TileInstances } from "../rendering/tile-instances.ts";
import { ROOT_COUNT, rootLevel, rootMaxLevel, rootPoint, tileKey } from "./roots.ts";

export interface TileAddress {
  root: number;
  level: number;
  x: number;
  y: number;
}
export interface ResidentTile extends TileAddress {
  key: string;
  /** Texture-array layer. Layer zero is reserved for "nothing resident". */
  slot: number;
  /** Frame on which a drawn tile last referenced this record (LRU). */
  used: number;
  /** Clock time at which the record was first drawn; starts its fade-in. */
  fadeStart?: number;
}
export interface TilePair<T> {
  best?: T;
  parent?: T;
  /** Smoothstepped 0..1 weight of `best` over `parent`. */
  blend: number;
}

export interface ResidentTilesOptions<Payload, Extra> {
  /** Number of texture layers available for tiles (6..255). */
  slots: number;
  /** Name used in failure warnings. */
  label: string;
  /** Finest level the source can supply. Read on every plan. */
  maxLevel(): number;
  /** Whether the source publishes this address. Unavailable tiles are never planned or drawn. */
  available(root: number, level: number, x: number, y: number): boolean;
  /** Fetch, validate and decode one tile. Rejection counts as one failed attempt. */
  load(tile: TileAddress, signal: AbortSignal): Promise<Payload>;
  /** Upload a loaded payload into `slot`; the returned fields are kept on the record. */
  store(slot: number, payload: Payload, tile: TileAddress): Extra;
  /** Called after any request settles, once the queue has been refilled. */
  onChange(): void;
  /** Keep the tiles under the camera at every level, even when off screen. */
  coverGround?: boolean;
  /** Requests started elsewhere that share the four-request budget. */
  busy?(): number;
  /** A tile has failed for good. Defaults to a console warning. */
  onError?(error: unknown): void;
}

const MAX_IN_FLIGHT = 4;
const MAX_ATTEMPTS = 3;
const ROOT_PRIORITY = 1e20;
const GROUND_PRIORITY = 1e18;
export const DEFAULT_FADE_MS = 300;

/** Eased 0..1 progress of a fade. One that has not started is 0, and a zero duration is 1. */
export function fadeWeight(start: number | undefined, now: number, fadeMs: number): number {
  if (start === undefined) return 0;
  const t = fadeMs === 0 ? 1 : Math.min(1, Math.max(0, (now - start) / fadeMs));
  return t * t * (3 - 2 * t);
}

export function addressAt(root: number, level: number, u: number, v: number): TileAddress {
  const n = 2 ** level;
  return {
    root,
    level,
    x: Math.min(n - 1, Math.max(0, Math.floor(u * n))),
    y: Math.min(n - 1, Math.max(0, Math.floor(v * n))),
  };
}

export const tileKeyAt = (root: number, level: number, u: number, v: number) => {
  const { x, y } = addressAt(root, level, u, v);
  return tileKey(root, level, x, y);
};

/**
 * A bounded set of streamed quadtree tiles resident in texture-array slots.
 *
 * Each frame, `plan` picks the tiles the drawn instances need. It lowers one
 * uniform level cap until every visible leaf is covered within the slot budget,
 * then spends spare slots refining the ground under the camera and the most
 * important instances. `pump` loads missing tiles coarse-parent-first, at most
 * four at a time, and gives up on a tile after three failures. `pair` returns
 * the finest resident tile at a point and the parent it is fading in over.
 */
export function createResidentTiles<Payload, Extra extends object = object>(
  options: ResidentTilesOptions<Payload, Extra>,
) {
  type Record = ResidentTile & Extra;
  type Wanted = TileAddress & { key: string; priority: number };
  const { slots: limit } = options;
  if (!Number.isInteger(limit) || limit < ROOT_COUNT || limit > 255)
    throw new RangeError(`${options.label} slots must be ${ROOT_COUNT}..255.`);
  const ready = new Map<string, Record>();
  const pending = new Map<string, { controller: AbortController; speculative: boolean }>();
  const failed = new Set<string>();
  const attempts = new Map<string, number>();
  const free = Array.from({ length: limit }, (_, i) => limit - i);
  let wanted = new Map<string, Wanted>();
  let prefetch = new Map<string, Wanted>();
  let frame = 0,
    now = 0,
    fadeMs = 0,
    cap = 0,
    disposed = false;
  let planned: { instances: TileInstances; revision: number; priorities: Float64Array } | undefined;
  const counts = { visibleLoads: 0, speculativeLoads: 0, prefetchHits: 0 };

  const desired = (key: string) => wanted.has(key) || prefetch.has(key);
  const missing = (key: string) => !ready.has(key) && !failed.has(key);
  function candidate(root: number, level: number, u: number, v: number, priority: number) {
    const address = addressAt(root, level, u, v);
    if (!options.available(address.root, address.level, address.x, address.y)) return undefined;
    return { ...address, key: tileKey(root, level, address.x, address.y), priority };
  }

  function allocate(speculative: boolean): number | undefined {
    if (free.length) return free.pop();
    let oldest: Record | undefined;
    for (const record of ready.values()) {
      if (wanted.has(record.key) || (speculative && prefetch.has(record.key))) continue;
      if (!oldest || record.used < oldest.used) oldest = record;
    }
    if (!oldest) return undefined;
    ready.delete(oldest.key);
    return oldest.slot;
  }

  function start(item: Wanted, speculative: boolean) {
    const controller = new AbortController();
    pending.set(item.key, { controller, speculative });
    const address = { root: item.root, level: item.level, x: item.x, y: item.y };
    void options
      .load(address, controller.signal)
      .then((payload) => {
        if (disposed || controller.signal.aborted || !desired(item.key)) return;
        const slot = allocate(!wanted.has(item.key));
        if (slot === undefined) return;
        const extra = options.store(slot, payload, address);
        ready.set(item.key, { ...address, key: item.key, slot, used: frame, ...extra } as Record);
        attempts.delete(item.key);
        if (speculative) counts.speculativeLoads++;
        else counts.visibleLoads++;
      })
      .catch((error) => {
        if (disposed || controller.signal.aborted || !desired(item.key)) return;
        const tries = (attempts.get(item.key) ?? 0) + 1;
        attempts.set(item.key, tries);
        // shortcut: failures stick for the session, raise MAX_ATTEMPTS or add a timer if a
        // longer outage should recover.
        if (tries < MAX_ATTEMPTS) return;
        failed.add(item.key);
        const report = options.onError ?? console.warn;
        report(new Error(`${options.label} tile ${item.key} failed`, { cause: error }));
      })
      .finally(() => {
        pending.delete(item.key);
        if (disposed) return;
        pump();
        options.onChange();
      });
  }

  /** Drop stale work, then start the most important missing loads. */
  function pump(): void {
    if (disposed) return;
    for (const key of failed) if (!desired(key)) failed.delete(key);
    for (const key of attempts.keys()) if (!desired(key)) attempts.delete(key);
    const visible = [...wanted.values()].filter((tile) => missing(tile.key));
    for (const [key, request] of pending)
      if (!desired(key) || (request.speculative && visible.length)) request.controller.abort();
    // Roots first, then by priority. Speculation runs only when nothing visible is missing.
    const queue = visible.length
      ? visible.sort(
          (a, b) => Number(b.level === 0) - Number(a.level === 0) || b.priority - a.priority,
        )
      : [...prefetch.values()].sort((a, b) => b.priority - a.priority);
    for (const item of queue) {
      if (pending.size + (options.busy?.() ?? 0) >= MAX_IN_FLIGHT) break;
      if (!missing(item.key) || pending.has(item.key)) continue;
      const speculative = !wanted.has(item.key);
      if (speculative && [...pending.values()].some((p) => p.speculative)) continue;
      if (item.level > 0 && !speculative) {
        const parent = tileKey(item.root, item.level - 1, item.x >> 1, item.y >> 1);
        if (wanted.has(parent) && missing(parent)) continue;
      }
      start(item, speculative);
    }
  }

  /** Choose this frame's wanted tiles. `priorities[i]` ranks drawn instance i. */
  function plan(instances: TileInstances, priorities: ArrayLike<number>): void {
    frame++;
    // The same inputs give the same plan. Speculation is still rebuilt every frame.
    if (
      planned?.instances === instances &&
      planned.revision === instances.revision &&
      planned.priorities.length === priorities.length &&
      planned.priorities.every((priority, i) => priority === priorities[i])
    ) {
      prefetch = new Map();
      return;
    }
    planned = {
      instances,
      revision: instances.revision,
      priorities: Float64Array.from(priorities),
    };
    const maxLevel = options.maxLevel();
    const origin = instances.origin;
    const ground =
      Math.hypot(origin[0], origin[1], origin[2]) > 0
        ? rootPoint(origin[0], origin[1], origin[2])
        : undefined;
    const centers = Array.from({ length: instances.count }, (_, i) => {
      const [u, v] = instanceCenter(instances, i);
      const root = instances.roots[i];
      return [
        root,
        u,
        v,
        Math.min(rootMaxLevel(root, maxLevel), instanceLevel(instances, i)),
      ] as const;
    });
    const add = (root: number, level: number, u: number, v: number, priority: number) => {
      const tile = candidate(root, level, u, v, priority);
      if (!tile) return;
      const old = wanted.get(tile.key);
      if (old) old.priority += priority;
      else wanted.set(tile.key, tile);
    };
    // Lower one uniform cap until every visible leaf is covered within the slots. It is a
    // dataset level, so the same cap means the same resolution on every root.
    for (cap = maxLevel; ; cap--) {
      wanted = new Map();
      for (let root = 0; root < ROOT_COUNT; root++)
        wanted.set(tileKey(root, 0, 0, 0), {
          root,
          level: 0,
          x: 0,
          y: 0,
          key: tileKey(root, 0, 0, 0),
          priority: ROOT_PRIORITY,
        });
      for (let level = 1; level <= cap && wanted.size <= limit; level++) {
        for (let i = 0; i < centers.length && wanted.size <= limit; i++) {
          const [root, u, v, finest] = centers[i];
          const own = rootLevel(root, level);
          if (own > 0 && own <= finest) add(root, own, u, v, priorities[i]);
        }
        if (options.coverGround && ground) {
          const own = rootLevel(ground[0], level);
          if (own > 0) add(ground[0], own, ground[1], ground[2], GROUND_PRIORITY);
        }
      }
      if (wanted.size <= limit || cap === 0) break;
    }
    // Spare slots, and slots taken from the least important refinements, keep the
    // ground under the camera and the most important instances at their own level.
    const uniform = new Set(wanted.keys());
    const deepen = (root: number, level: number, u: number, v: number, priority: number) => {
      const tile = candidate(root, level, u, v, priority);
      if (!tile) return true;
      const old = wanted.get(tile.key);
      if (old) {
        old.priority = Math.max(old.priority, priority);
        return true;
      }
      if (wanted.size >= limit) {
        let worst: Wanted | undefined;
        for (const other of wanted.values()) {
          if (uniform.has(other.key) || other.level === 0 || other.priority >= 1e17) continue;
          if (other.priority >= (worst?.priority ?? priority)) continue;
          // A refinement cannot evict the parent still needed by its children.
          let hasChild = false;
          for (let q = 0; q < 4 && !hasChild; q++)
            hasChild = wanted.has(
              tileKey(other.root, other.level + 1, other.x * 2 + (q & 1), other.y * 2 + (q >> 1)),
            );
          if (!hasChild) worst = other;
        }
        if (!worst) return false;
        wanted.delete(worst.key);
      }
      wanted.set(tile.key, tile);
      return true;
    };
    if (ground)
      for (
        let level = Math.max(1, rootLevel(ground[0], cap + 1));
        level <= rootMaxLevel(ground[0], maxLevel);
        level++
      )
        if (!deepen(ground[0], level, ground[1], ground[2], GROUND_PRIORITY)) break;
    const order = centers.map((_, i) => i).sort((a, b) => priorities[b] - priorities[a]);
    for (const i of order) {
      const [root, u, v, finest] = centers[i];
      for (let level = Math.max(1, rootLevel(root, cap + 1)); level <= finest; level++)
        if (!deepen(root, level, u, v, priorities[i])) break;
    }
    for (const key of wanted.keys()) if (prefetch.has(key) && ready.has(key)) counts.prefetchHits++;
    prefetch = new Map();
  }

  return {
    plan,
    pump,
    /** `available` or `maxLevel` changed: the next `plan` must run in full. */
    invalidate() {
      planned = undefined;
    },
    /** Queue a speculative tile for idle bandwidth. Cleared by the next plan. */
    prefetch(root: number, level: number, x: number, y: number, priority: number) {
      if (!options.available(root, level, x, y)) return;
      const key = tileKey(root, level, x, y);
      if (!wanted.has(key) && !prefetch.has(key))
        prefetch.set(key, { root, level, x, y, key, priority });
    },
    /** Set the fade clock. `fadeMs` of zero reveals tiles immediately. */
    setClock(time: number, duration = fadeMs) {
      now = time;
      fadeMs = duration;
    },
    /**
     * The finest resident tile containing (u, v) at or above `level`, and the
     * parent it is still fading in over. `activate` marks the tiles as drawn this
     * frame: it starts their fades and refreshes their LRU position.
     */
    pair(root: number, level: number, u: number, v: number, activate = false): TilePair<Record> {
      let best: Record | undefined,
        parent: Record | undefined,
        blend = 1;
      for (let l = 0; l <= level; l++) {
        const { x, y } = addressAt(root, l, u, v);
        const record = ready.get(tileKey(root, l, x, y));
        if (!record || !options.available(root, l, x, y)) continue;
        if (activate) record.used = frame;
        // Finish the parent fade before revealing its child.
        if (best && blend < 1) break;
        parent = best;
        best = record;
        if (activate) record.fadeStart ??= now;
        blend = fadeWeight(record.fadeStart, now, fadeMs);
      }
      return { best, parent, blend };
    },
    /** Start the roots' fades even off screen. Returns whether any is still fading. */
    startRootFades() {
      let fading = false;
      for (let root = 0; root < ROOT_COUNT; root++) {
        const tile = ready.get(tileKey(root, 0, 0, 0));
        if (!tile) continue;
        tile.fadeStart ??= now;
        fading ||= now - tile.fadeStart < fadeMs;
      }
      return fading;
    },
    /** Every wanted tile is resident or has failed. Fades may still be running. */
    settled() {
      for (const key of wanted.keys()) if (missing(key)) return false;
      return true;
    },
    /** Whether any resident tile is still fading in. */
    fading() {
      for (const { fadeStart } of ready.values())
        if (fadeStart !== undefined && now - fadeStart < fadeMs) return true;
      return false;
    },
    get: (key: string) => ready.get(key),
    resident: () => ready.values(),
    /** Number of wanted tiles; the remaining slots are free for prefetch. */
    get wantedCount() {
      return wanted.size;
    },
    get prefetchCount() {
      return prefetch.size;
    },
    /** Uniform level cap chosen by the last plan. */
    get cap() {
      return cap;
    },
    stats: () => ({
      resident: ready.size,
      loading: pending.size,
      wanted: wanted.size,
      prefetch: prefetch.size,
      failed: failed.size,
      cap,
      ...counts,
    }),
    dispose() {
      disposed = true;
      for (const request of pending.values()) request.controller.abort();
      pending.clear();
      ready.clear();
    },
  };
}
export type ResidentTiles<Payload, Extra extends object = object> = ReturnType<
  typeof createResidentTiles<Payload, Extra>
>;
