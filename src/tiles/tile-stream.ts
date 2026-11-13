import {
  DataArrayTexture,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
  RGFormat,
  SRGBColorSpace,
} from "three/webgpu";
import { instanceCenter, instanceLevel, type TileInstances } from "../rendering/tile-instances.ts";
import { writeTilePair, type TileTexels } from "../rendering/binding-row.ts";
import { screenImportance, type StreamingView } from "../imagery/priority.ts";
import { rootMaxLevel } from "./roots.ts";
import {
  createResidentTiles,
  DEFAULT_FADE_MS,
  type ResidentTilesOptions,
  type TileAddress,
} from "./resident-tiles.ts";

export interface TileStreamOptions<Payload, Extra extends object> extends Omit<
  ResidentTilesOptions<Payload, Extra>,
  "store"
> {
  /** Core texels across a tile, and the gutter around it. */
  tileSize: number;
  gutter: number;
  /** "color": sRGB RGBA8, filtered. "height": two raw bytes per texel, unfiltered. */
  texels: "color" | "height";
  /** Bytes of the reserved "nothing resident" layer, one texel's worth repeated. */
  empty?: ArrayLike<number>;
  /** Floats per drawn instance in `bindings`. The tile pair comes first. */
  stride: number;
  /** Instances the bindings can hold. */
  capacity: number;
  /** Rows run bottom-up in the texture. */
  flipV?: boolean;
  fadeMs?: number;
  /** A loaded payload's texel bytes, `width² · bytes per texel` long. */
  bytes(payload: Payload): Uint8Array;
  /** Fields kept on the resident record. */
  keep?(payload: Payload, tile: TileAddress): Extra;
}

/**
 * Streamed tiles resident in one texture array, with each drawn instance's tile pair
 * written into `bindings`. Owns the texture, the slot uploads, the fade clock and the
 * per-frame plan; a cache adds only what its tiles mean.
 */
export function createTileStream<Payload, Extra extends object = object>(
  options: TileStreamOptions<Payload, Extra>,
) {
  const { tileSize, gutter, slots, capacity, stride } = options;
  const width = tileSize + 2 * gutter,
    texelBytes = options.texels === "color" ? 4 : 2,
    layerBytes = width * width * texelBytes,
    fadeMs = Math.max(0, options.fadeMs ?? DEFAULT_FADE_MS);
  const data = new Uint8Array(layerBytes * (slots + 1));
  if (options.empty)
    for (let i = 0; i < layerBytes; i += options.empty.length) data.set(options.empty, i);
  const texture = new DataArrayTexture(data, width, width, slots + 1);
  texture.name = `Resident ${options.label.toLowerCase()} tiles`;
  if (options.texels === "color") {
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = texture.magFilter = LinearFilter;
  } else {
    texture.format = RGFormat;
    texture.colorSpace = NoColorSpace;
    texture.minFilter = texture.magFilter = NearestFilter;
    texture.unpackAlignment = 1;
  }
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  const bindings = { data: new Float32Array(capacity * stride) };
  /** Bumped when a slot's contents change, so dependents rebuild only what moved. */
  const slotVersions = new Uint32Array(slots + 1);
  let revision = 0,
    clock = 0,
    fade = 0,
    animating = false;
  const tiles = createResidentTiles<Payload, Extra>({
    ...options,
    // A wrong size is a failed load, retried like any other.
    async load(tile, signal) {
      const payload = await options.load(tile, signal);
      if (options.bytes(payload).length !== layerBytes)
        throw new Error(`${options.label} tile size mismatch.`);
      return payload;
    },
    store(slot, payload, tile) {
      data.set(options.bytes(payload), slot * layerBytes);
      slotVersions[slot]++;
      revision++;
      texture.addLayerUpdate(slot);
      texture.needsUpdate = true;
      return options.keep?.(payload, tile) ?? ({} as Extra);
    },
  });
  const texels: TileTexels = {
    scale: tileSize / width,
    offset: gutter / width,
    flipV: options.flipV,
  };
  return {
    tiles,
    texture,
    bindings,
    slotVersions,
    /** Changes whenever any slot's contents do. */
    get revision() {
      return revision;
    },
    /** Texels across a layer, gutter included. */
    width,
    /** The fade clock, and the fade length in use. */
    get clock() {
      return clock;
    },
    get fadeMs() {
      return fade;
    },
    /** Move the fade clock. Without a view, fades finish at once. */
    advance(now: number, view = true) {
      clock = now;
      fade = view ? fadeMs : 0;
      tiles.setClock(clock, fade);
    },
    /** Start a frame: check capacity, move the clock and plan the tiles the instances need. Returns each instance's priority. */
    plan(instances: TileInstances, view?: StreamingView) {
      if (instances.count > capacity)
        throw new RangeError(`${options.label} instance capacity exceeded.`);
      this.advance(view?.now ?? clock, !!view);
      animating = false;
      const priorities = Array.from({ length: instances.count }, (_, i) =>
        screenImportance(instances, i, view),
      );
      tiles.plan(instances, priorities);
      return priorities;
    },
    /** Write each instance's tile pair; `row` adds what follows the pair. */
    write(instances: TileInstances, row?: (i: number, at: number) => void) {
      const deepest = options.maxLevel();
      for (let i = 0; i < instances.count; i++) {
        const root = instances.roots[i],
          [u, v] = instanceCenter(instances, i),
          level = Math.min(rootMaxLevel(root, deepest), instanceLevel(instances, i)),
          pair = tiles.pair(root, level, u, v, true);
        animating ||= pair.best !== undefined && pair.blend < 1;
        writeTilePair(bindings.data, i * stride, pair, instances, i, texels);
        row?.(i, i * stride);
      }
    },
    /** Keep frames coming while something outside `write` fades. */
    animate() {
      animating = true;
    },
    pump: () => tiles.pump(),
    needsFrame: () => animating,
    /** Every wanted tile has arrived or failed, and no fade is running. */
    settled: () => !animating && !(options.busy?.() ?? 0) && tiles.settled(),
    dispose() {
      tiles.dispose();
      texture.dispose();
    },
  };
}
export type TileStream<Payload, Extra extends object = object> = ReturnType<
  typeof createTileStream<Payload, Extra>
>;
