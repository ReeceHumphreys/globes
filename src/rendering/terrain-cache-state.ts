/** CPU ownership only. GPU resources and compute dispatch stay in terrain-compute.ts. */
export interface TerrainCacheOptions {
  normals?: boolean;
  sunlight?: boolean;
  /** Bounded geometry-patch slots, independent of height residency. */
  sunlightSlots?: number;
  gradientTilesPerFrame?: number;
  sunlightTilesPerFrame?: number;
  /** Quiet period before baking sunlight after an input change. */
  settleMs?: number;
}
export function terrainCacheSettings(value: false | TerrainCacheOptions = {}) {
  const options = value === false ? { normals: false, sunlight: false } : value;
  const result = {
    normals: options.normals ?? true,
    sunlight: options.sunlight ?? true,
    sunlightSlots: options.sunlightSlots ?? 128,
    gradientTilesPerFrame: options.gradientTilesPerFrame ?? 4,
    sunlightTilesPerFrame: options.sunlightTilesPerFrame ?? 4,
    settleMs: options.settleMs ?? 100,
  };
  for (const key of ["sunlightSlots", "gradientTilesPerFrame", "sunlightTilesPerFrame"] as const)
    if (
      !Number.isInteger(result[key]) ||
      result[key] < 1 ||
      result[key] > (key === "sunlightSlots" ? 255 : 64)
    )
      throw new RangeError(`Invalid terrain cache ${key}`);
  if (!Number.isFinite(result.settleMs) || result.settleMs < 0 || result.settleMs > 10000)
    throw new RangeError("Invalid terrain cache settleMs");
  return result;
}
export const GRADIENT_READY_BIT = 256;
export const RENDER_BINDING_STRIDE = 25; // 11 imagery + 13 height + one packed cache flag
export interface SunlightEntry {
  readonly slot: number;
  readonly signature: Float32Array;
  key: string;
  used: number;
  ready: boolean;
}
/** Entries are usable only in the current global height/Sun epoch. No hash collisions. */
export function createSunlightCacheState(capacity: number) {
  const entries = new Map<string, SunlightEntry>();
  const signatures = new Float32Array(capacity * 12);
  const pool = Array.from({ length: capacity }, (_, slot): SunlightEntry => ({
    slot,
    key: "",
    used: -1,
    ready: false,
    signature: signatures.subarray(slot * 12, (slot + 1) * 12),
  }));
  let frame = 0,
    epoch: string | undefined,
    changedAt = 0;
  const free = Array.from({ length: capacity }, (_, i) => capacity - 1 - i);
  return {
    begin(nextEpoch: string, now: number) {
      frame++;
      if (epoch !== nextEpoch) {
        epoch = nextEpoch;
        changedAt = now;
        entries.clear();
        free.length = 0;
        for (let i = capacity - 1; i >= 0; i--) free.push(i);
      }
      return changedAt;
    },
    touch(key: string, signature: ArrayLike<number>, offset = 0) {
      let entry = entries.get(key);
      if (!entry) {
        let slot = free.pop();
        if (slot === undefined) {
          let oldest: SunlightEntry | undefined;
          for (const candidate of entries.values())
            if (candidate.used !== frame && (!oldest || candidate.used < oldest.used))
              oldest = candidate;
          if (!oldest) return undefined;
          entries.delete(oldest.key);
          slot = oldest.slot;
        }
        entry = pool[slot];
        entry.key = key;
        entry.used = frame;
        entry.ready = false;
        entry.signature.fill(NaN);
        entries.set(key, entry);
      }
      entry.used = frame;
      for (let j = 0; j < 12; j++)
        if (entry.signature[j] !== signature[offset + j]) {
          entry.ready = false;
          for (let k = 0; k < 12; k++) entry.signature[k] = signature[offset + k];
          break;
        }
      return entry;
    },
    get size() {
      return entries.size;
    },
    get ready() {
      let count = 0;
      for (const entry of entries.values()) if (entry.ready) count++;
      return count;
    },
    clear() {
      epoch = undefined;
      entries.clear();
    },
  };
}
