import * as THREE from "three/webgpu";
import { Fn, instanceIndex, uvec2, uniform, texture, textureStore, wgslFn } from "three/tsl";
import gradientShader from "./shaders/height-gradient.wgsl?raw";
import bakeShader from "./shaders/bake-sunlight.wgsl?raw";
import type { HeightTileCache } from "../elevation/tile-cache.ts";
import { HEIGHT_STRIDE } from "../elevation/tiles.ts";
import type { TileInstances } from "./tile-instances.ts";
import { screenImportance, type StreamingView } from "../imagery/priority.ts";
import {
  createSunlightCacheState,
  GRADIENT_READY_BIT,
  terrainCacheSettings,
  type TerrainCacheOptions,
} from "./terrain-cache-state.ts";

type FunctionNode = ReturnType<typeof wgslFn>;
export interface TerrainCacheStats {
  gradientReady: number;
  gradientSlots: number;
  sunlightReady: number;
  sunlightSlots: number;
  fallbackTiles: number;
  bytes: number;
  state: "disabled" | "compiling" | "ready" | "warming" | "settling" | "failed";
}
export interface TerrainComputeNodes {
  heightTiles: THREE.Node;
  indexMap: THREE.Node;
  radius: THREE.Node;
  sun: THREE.Node;
  minHeight: THREE.Node;
  maxHeight: THREE.Node;
  coreSize: THREE.Node;
  gutter: THREE.Node;
  maxLevel: THREE.Node;
  steps: THREE.Node;
}
/** Own derived textures; dispatch only through Three.js so GPU ownership stays unified. */
export function createTerrainCompute(
  heights: HeightTileCache,
  segments: number,
  nodes: TerrainComputeNodes,
  functions: { direction: FunctionNode; surfaceHeight: FunctionNode; sunlight: FunctionNode },
  options: TerrainCacheOptions,
) {
  const settings = terrainCacheSettings(options);
  const { width, depth } = heights.texture.image as { width: number; depth: number };
  const grid = segments + 1,
    columns = Math.min(16, settings.sunlightSlots),
    rows = Math.ceil(settings.sunlightSlots / columns);
  const gradients = new THREE.StorageArrayTexture(width, width, depth);
  gradients.name = "Cached terrain gradients";
  gradients.type = THREE.HalfFloatType;
  gradients.format = THREE.RGBAFormat;
  gradients.colorSpace = THREE.NoColorSpace;
  gradients.generateMipmaps = false;
  const sunlight = new THREE.StorageTexture(columns * grid, rows * grid);
  sunlight.name = "Cached patch sunlight";
  sunlight.type = THREE.FloatType;
  sunlight.format = THREE.RedFormat;
  sunlight.minFilter = sunlight.magFilter = THREE.NearestFilter;
  sunlight.generateMipmaps = false;
  Object.assign(sunlight, { mipmapsAutoUpdate: false });
  const versions = new Uint32Array(depth);
  const sunState = createSunlightCacheState(settings.sunlightSlots);
  const flags = new Float32Array(heights.bindings.data.length / HEIGHT_STRIDE);
  const sourceLayer = uniform(0),
    destination = uniform(new THREE.Vector2());
  const jobFace = uniform(new THREE.Vector4()),
    jobRotation = uniform(new THREE.Vector2());
  const jobLayers = uniform(new THREE.Vector2()),
    jobBest = uniform(new THREE.Vector4()),
    jobParent = uniform(new THREE.Vector4());
  const include = (fn: FunctionNode) => fn as unknown as THREE.CodeNode;
  const gradientFn = wgslFn(gradientShader);
  const gradientJob = Fn(() => {
    const coord = uvec2(instanceIndex.mod(width), instanceIndex.div(width));
    const store = textureStore(
      gradients,
      coord,
      gradientFn({ heightTiles: nodes.heightTiles, coord, layer: sourceLayer }),
    );
    store.depthNode = sourceLayer;
  })()
    .compute(width * width, [64])
    .setName("Terrain gradient cache");
  const bakeFn = wgslFn(bakeShader, [
    include(functions.direction),
    include(functions.surfaceHeight),
    include(functions.sunlight),
  ]);
  const sunlightJob = Fn(() => {
    const coord = uvec2(instanceIndex.mod(grid), instanceIndex.div(grid));
    const value = bakeFn({
      ...nodes,
      coord,
      segments: uniform(segments),
      faceUV: jobFace,
      rotation: jobRotation,
      layers: jobLayers,
      bestUV: jobBest,
      parentUV: jobParent,
    });
    textureStore(sunlight, coord.add(uvec2(destination)), value);
  })()
    .compute(grid * grid, [64])
    .setName("Terrain sunlight cache");
  let compiled = false,
    failed = false,
    disposed = false,
    released = false;
  let compilation: Promise<void> | undefined;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let wakeAt = Infinity;
  let gradientQueue = 0,
    sunQueue = 0;
  const stats: TerrainCacheStats = {
    gradientReady: 0,
    gradientSlots: depth - 1,
    sunlightReady: 0,
    sunlightSlots: settings.sunlightSlots,
    fallbackTiles: 0,
    bytes: 0,
    state: "disabled",
  };
  function release() {
    if (released) return;
    released = true;
    gradientJob.dispose();
    sunlightJob.dispose();
    gradients.dispose();
    sunlight.dispose();
  }
  function schedule(now: number, due: number, requestRender: () => void) {
    if (wake && wakeAt <= due) return;
    if (wake) clearTimeout(wake);
    wakeAt = due;
    wake = setTimeout(
      () => {
        wake = undefined;
        wakeAt = Infinity;
        if (!disposed) requestRender();
      },
      Math.max(0, due - now),
    );
  }
  function updateStats() {
    stats.gradientReady = 0;
    for (let slot = 1; slot < depth; slot++)
      if (versions[slot] > 0 && versions[slot] === heights.slotVersions[slot])
        stats.gradientReady++;
    stats.sunlightReady = sunState.ready;
    stats.bytes = width * width * depth * 8 + columns * rows * grid * grid * 4;
  }
  function prepare(
    renderer: THREE.WebGPURenderer,
    instances: TileInstances,
    now: number,
    epoch: string,
    activeNormals: boolean,
    activeSunlight: boolean,
    view: StreamingView,
    requestRender: () => void,
    report: (error: unknown) => void,
  ) {
    flags.fill(0, 0, instances.count);
    stats.fallbackTiles = instances.count;
    const changedAt = sunState.begin(`${heights.revision}/${epoch}`, now);
    if (disposed || failed || (!activeNormals && !activeSunlight)) {
      stats.state = failed ? "failed" : "disabled";
      updateStats();
      return flags;
    }
    if (!compiled) {
      stats.state = "compiling";
      if (!compilation)
        compilation = renderer
          .compileComputeAsync([gradientJob, sunlightJob])
          .then(() => {
            if (!disposed) {
              compiled = true;
              requestRender();
            }
          })
          .catch((error) => {
            failed = true;
            if (!disposed) {
              report(error);
              requestRender();
            }
          })
          .finally(() => {
            compilation = undefined;
            if (disposed) release();
          });
      updateStats();
      return flags;
    }
    try {
      gradientQueue = sunQueue = 0;
      if (activeNormals)
        for (let slot = 1, budget = settings.gradientTilesPerFrame; slot < depth; slot++) {
          const version = heights.slotVersions[slot];
          if (!version || versions[slot] === version) continue;
          if (budget-- > 0) {
            sourceLayer.value = slot;
            renderer.compute(gradientJob);
            versions[slot] = version;
          } else gradientQueue++;
        }
      const stable = !heights.needsFrame() && now - changedAt >= settings.settleMs;
      stats.state = activeSunlight && !stable ? "settling" : "ready";
      let sunBudget = settings.sunlightTilesPerFrame;
      const order =
        activeSunlight && stable
          ? Array.from({ length: instances.count }, (_, i) => i).sort(
              (a, b) => screenImportance(instances, b, view) - screenImportance(instances, a, view),
            )
          : undefined;
      // The ordered pass protects high-importance patches from low-priority eviction.
      if (order)
        for (const i of order) {
          const b = i * HEIGHT_STRIDE,
            j = i * 4;
          if (heights.bindings.data[b + 10] < 1 || heights.bindings.data[b] < 0.5) continue;
          const key = `${instances.faces[i]}/${instances.faceUVs[j]}/${instances.faceUVs[j + 1]}/${instances.faceUVs[j + 2]}`;
          const entry = sunState.touch(key, heights.bindings.data, b);
          if (!entry) continue;
          if (!entry.ready) {
            if (sunBudget > 0) {
              sunBudget--;
              jobFace.value.fromArray(instances.faceUVs, j);
              jobRotation.value.fromArray(instances.rotations, i * 2);
              jobLayers.value.fromArray(heights.bindings.data, b);
              jobBest.value.fromArray(heights.bindings.data, b + 2);
              jobParent.value.fromArray(heights.bindings.data, b + 6);
              destination.value.set(
                (entry.slot % columns) * grid,
                Math.floor(entry.slot / columns) * grid,
              );
              renderer.compute(sunlightJob);
              // compute() submits before render(); queue order makes this readable now.
              entry.ready = true;
            } else sunQueue++;
          }
          if (entry.ready) {
            flags[i] = entry.slot + 1;
            stats.fallbackTiles--;
          }
        }
      if (activeNormals)
        for (let i = 0; i < instances.count; i++) {
          const b = i * HEIGHT_STRIDE,
            slot = heights.bindings.data[b];
          if (
            slot > 0 &&
            heights.bindings.data[b + 10] >= 1 &&
            versions[slot] > 0 &&
            versions[slot] === heights.slotVersions[slot]
          )
            flags[i] += GRADIENT_READY_BIT;
        }
      // Warm caches on demanded frames; do not animate an otherwise idle viewer
      // solely to fill optional caches. Direct calculations cover remaining work.
      if ((gradientQueue || sunQueue) && stats.state === "ready") stats.state = "warming";
      if (activeSunlight && !stable && !heights.needsFrame())
        schedule(now, changedAt + settings.settleMs, requestRender);
    } catch (error) {
      failed = true;
      flags.fill(0);
      stats.state = "failed";
      stats.fallbackTiles = instances.count;
      report(error);
    }
    updateStats();
    return flags;
  }
  return {
    gradients,
    sunlight,
    columns,
    flags,
    stats,
    gradientJob,
    sunlightJob,
    prepare,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (wake) clearTimeout(wake);
      if (!compilation) release();
    },
  };
}
export type TerrainCompute = ReturnType<typeof createTerrainCompute>;
