import type { TerrainCacheOptions } from "./rendering/terrain-cache-state.ts";
import * as THREE from "three/webgpu";
import { createSelectionView, VIEW } from "./tiles/lod.ts";
import { selectAdaptiveTiles } from "./tiles/quadtree.ts";
import { createTileProducer } from "./tile-producer.ts";
import type { TileInstances } from "./rendering/tile-instances.ts";
import { createTileLayer } from "./rendering/tile-layer.ts";
import { loadImageryManifest, MissingImageryManifestError } from "./imagery/manifest.ts";
import { createImageryCache } from "./imagery/tile-cache.ts";
import { loadRegionalCatalog } from "./imagery/regions.ts";
import { loadHeightTiles } from "./elevation/tiles.ts";
import { createHeightTileCache, type HeightTileCache } from "./elevation/tile-cache.ts";
import { loadHeightField, sampleHeight, type HeightField } from "./elevation/height-field.ts";
import { createHeightBounds, type HeightBounds } from "./elevation/bounds.ts";
import { loadElevationBounds } from "./elevation/bounds-loader.ts";

import type {
  GlobeContext,
  GlobeFrame,
  GlobeSurface,
  GlobeStats,
  SurfaceLayer,
  TerrainLighting,
} from "./composition.ts";
export interface TiledSurfaceOptions {
  /** Equirectangular sRGB overview. A supplied texture transfers ownership. */
  overview?: string | THREE.Texture;
  /** Equirectangular sRGB night lights. A supplied texture transfers ownership. */
  nightLights?: string | THREE.Texture;
  imagery?: string;
  regions?: string;
  elevation?: { tiles?: string; global?: string };
  gridSegments?: number;
  tileCapacity?: number;
  maxLevel?: number;
  maxCellPixels?: number;
  imagerySlots?: number;
  heightSlots?: number;
  /** Optional lunar-style reflectance; Lambert is the generic default. */
  hapke?: boolean;
  /** GPU derived data with direct-shader fallbacks; enabled by default. */
  caches?: false | TerrainCacheOptions;
  /** Custom lighting without replacing geometry, streaming, or terrain normals. */
  lighting?: TerrainLighting;
  /** Ground-locked grain where resident imagery is magnified past its texels. */
  surfaceDetail?: boolean;
}

/** Optional tiled terrain implementation; the engine also accepts entirely custom surfaces. */
export function tiledSurface(options: TiledSurfaceOptions = {}) {
  let context: GlobeContext;
  let body: GlobeContext["body"], radius: number;
  let scene: THREE.Scene, camera: THREE.PerspectiveCamera;
  let requestRender: () => void, report: (error: unknown) => void;
  let disposed = false;
  let finishReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    finishReady = resolve;
  });
  let loadingStarted = false;
  const segments = options.gridSegments ?? 32,
    capacity = options.tileCapacity ?? 2048;
  const maxLevel = options.maxLevel ?? 20,
    cellPixels = options.maxCellPixels ?? 12;
  if (
    !Number.isInteger(segments) ||
    segments < 2 ||
    segments > 128 ||
    !Number.isInteger(capacity) ||
    capacity < 6 ||
    capacity > 65536 ||
    !Number.isInteger(maxLevel) ||
    maxLevel < 0 ||
    maxLevel > 20 ||
    !Number.isFinite(cellPixels) ||
    cellPixels <= 0
  )
    throw new RangeError("Invalid tiled surface settings");
  const url = (path: string) => new URL(path, document.baseURI).href;
  const view = createSelectionView();

  view[VIEW.Segments] = segments;
  view[VIEW.MaxLevel] = maxLevel;
  view[VIEW.MaxCellPixels] = cellPixels;
  view[VIEW.Cull] = 1;
  const relativeCamera = new THREE.PerspectiveCamera(),
    frustum = new THREE.Frustum();
  const projectionView = new THREE.Matrix4();
  const viewportHeight = () => context.viewport.height;
  const pixelRatio = () => context.viewport.pixelRatio;
  function updateView() {
    camera.updateMatrixWorld(true);
    relativeCamera.quaternion.copy(camera.quaternion);
    relativeCamera.projectionMatrix.copy(camera.projectionMatrix);
    relativeCamera.updateMatrixWorld(true);
    projectionView.multiplyMatrices(
      relativeCamera.projectionMatrix,
      relativeCamera.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(
      projectionView,
      THREE.WebGPUCoordinateSystem,
      camera.reversedDepth,
    );
    for (let i = 0; i < 6; i++) {
      const plane = frustum.planes[i],
        offset = VIEW.Planes + i * 4;
      view.set([plane.normal.x, plane.normal.y, plane.normal.z, plane.constant], offset);
    }
    view[VIEW.CameraX] = camera.position.x;
    view[VIEW.CameraY] = camera.position.y;
    view[VIEW.CameraZ] = camera.position.z;
    view[VIEW.ProjectionScale] =
      (viewportHeight() * pixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
  let elevation: HeightField | undefined,
    heightBounds: HeightBounds | undefined,
    heightTiles: HeightTileCache | undefined;
  let elevationEnabled = false;
  let previousQuery: Float64Array | undefined, previousInstances: TileInstances | undefined;
  let previousRevision = -1,
    previousBuffer: ArrayBuffer | undefined;
  const stats: GlobeStats = {
    tiles: 0,
    triangles: 0,
    deepestLevel: 0,
    selectionMs: 0,
    altitudeMeters: 0,
    imageryAvailable: false,
    elevationAvailable: false,
    imageryStatus: "Overview",
    elevationStatus: "No elevation configured",
  };
  const produce = createTileProducer(capacity, (tiles, query) =>
    selectAdaptiveTiles(tiles, query, elevationEnabled ? (heightTiles ?? heightBounds) : undefined),
  );
  function sampleSurfaceHeight(x: number, y: number, z: number): number {
    if (!elevationEnabled) return 0;
    return heightTiles
      ? heightTiles.sampleDirection(x, y, z)
      : elevation
        ? sampleHeight(elevation, x, y, z)
        : 0;
  }
  const groundHeight = () =>
    sampleSurfaceHeight(camera.position.x, camera.position.y, camera.position.z);
  function updateElevationBounds() {
    const field = heightTiles?.manifest ?? elevation;
    view[VIEW.MinElevation] = elevationEnabled && field ? Math.min(0, field.minMeters) : 0;
    view[VIEW.MaxElevation] = elevationEnabled && field ? Math.max(0, field.maxMeters) : 0;
  }
  let overview: THREE.Texture | undefined;
  let nightLights: THREE.Texture | undefined;
  let imagery: ReturnType<typeof createImageryCache> | undefined;
  let terrain: ReturnType<typeof createTileLayer>;
  let manifest: Awaited<ReturnType<typeof loadImageryManifest>> | undefined;
  async function attach(next: GlobeContext) {
    context = next;
    ({ body, scene, camera, requestRender } = context);
    radius = body.radiusMeters;
    report = context.reportError;
    view[VIEW.Radius] = radius;
    updateView();
    const manifestURL = options.imagery ? url(options.imagery) : undefined;
    if (typeof options.overview === "string") {
      overview = await new THREE.TextureLoader().loadAsync(url(options.overview));
      overview.colorSpace = THREE.SRGBColorSpace;
      overview.flipY = false;
    } else overview = options.overview;
    if (typeof options.nightLights === "string") {
      nightLights = await new THREE.TextureLoader()
        .loadAsync(url(options.nightLights))
        .catch((error: unknown) => {
          report(error);
          return undefined;
        });
      if (nightLights) {
        nightLights.colorSpace = THREE.SRGBColorSpace;
        nightLights.flipY = false;
        nightLights.wrapS = THREE.RepeatWrapping;
        nightLights.wrapT = THREE.ClampToEdgeWrapping;
      }
    } else nightLights = options.nightLights;
    if (context.signal.aborted) return;
    if (manifestURL)
      manifest = await loadImageryManifest(manifestURL, body, context.signal).catch((error) => {
        if (error instanceof MissingImageryManifestError) {
          report(error);
          return undefined;
        }
        throw error;
      });
    if (context.signal.aborted) return;
    const initial = produce(view);
    if (manifest && manifestURL)
      imagery = createImageryCache(
        manifest,
        manifestURL,
        capacity,
        requestRender,
        undefined,
        options.imagerySlots ?? 128,
      );
    terrain = createTileLayer(
      radius,
      segments,
      initial,
      overview,
      imagery,
      undefined,
      options.caches,
      options.lighting ?? context.environment?.lighting,
      nightLights,
      options.surfaceDetail ?? false,
    );
    terrain.setHapkeEnabled(options.hapke ?? false);
    terrain.setSurfaceLayer(manifest ? "imagery" : overview ? "overview" : "terrain");
    scene.add(terrain.group);
    stats.imageryAvailable = !!imagery;
  }
  function update({ now }: GlobeFrame) {
    terrain.setSun(context.sun.direction.x, context.sun.direction.y, context.sun.direction.z);
    updateView();
    const started = performance.now();
    const changed =
      previousInstances?.buffer.byteLength === 0 ||
      !previousQuery ||
      view.some((v, i) => v !== previousQuery![i]);
    const instances = changed ? produce(view) : previousInstances!;
    if (changed) {
      previousQuery = view.slice();
      previousInstances = instances;
    }
    stats.selectionMs = performance.now() - started;
    if (instances.revision !== previousRevision || instances.buffer !== previousBuffer) {
      terrain.commit(instances);
      previousRevision = instances.revision;
      previousBuffer = instances.buffer;
    }
    const streamingView = {
      clipFromRelative: projectionView.elements,
      projectionScale: view[VIEW.ProjectionScale],
      now,
    };
    imagery?.update(instances, streamingView);
    heightTiles?.update(instances, streamingView);
    terrain.prepareCaches(context.renderer, now, streamingView, requestRender, report);
    terrain.commitImagery(instances.count);
    stats.terrainCaches = terrain.cacheStats();
    stats.tiles = instances.count;
    stats.triangles = instances.count * segments * segments * 2;

    stats.deepestLevel = 0;
    for (let i = 0; i < instances.count; i++)
      stats.deepestLevel = Math.max(
        stats.deepestLevel,
        Math.round(Math.log2(radius / instances.sizes[i * 2])),
      );
    stats.imageryStatus = imagery?.status() ?? "Overview";
    if (heightTiles) stats.elevationStatus = heightTiles.status();
    if (!loadingStarted) {
      loadingStarted = true;
      void loadOptionalData().finally(finishReady);
    }
    if (imagery?.needsFrame() || heightTiles?.needsFrame()) requestRender();
  }
  async function loadData() {
    if (options.regions && imagery && manifest) {
      void loadRegionalCatalog(url(options.regions), manifest, context.signal)
        .then((catalog) => {
          if (!disposed && !context.signal.aborted && catalog)
            imagery!.setRegions(catalog, url(options.regions!));
        })
        .catch((error) => {
          if (!disposed && !context.signal.aborted) report(error);
        });
    }
    if (!options.elevation) return;
    stats.elevationStatus = "Loading elevation";
    requestRender();
    let heightManifest;
    if (options.elevation.tiles)
      heightManifest = await loadHeightTiles(
        url(options.elevation.tiles),
        context.signal,
        body,
      ).catch((error) => {
        if (!disposed && !context.signal.aborted) report(error);
        return undefined;
      });
    if (disposed || context?.signal.aborted) return;
    if (heightManifest && options.elevation.tiles) {
      heightTiles = createHeightTileCache(
        heightManifest,
        url(options.elevation.tiles),
        capacity,
        () => {
          previousQuery = undefined;
          requestRender();
        },
        undefined,
        options.heightSlots ?? 64,
      );
      terrain.setHeightTiles(heightTiles);
    } else if (options.elevation.global) {
      elevation = await loadHeightField(url(options.elevation.global), {
        body,
        signal: context.signal,
        onProgress(loaded, total) {
          stats.elevationStatus = `Elevation loading · ${Math.round((loaded / total) * 100)}%`;
          requestRender();
        },
      });
      if (disposed || context?.signal.aborted) return;
      try {
        heightBounds = await loadElevationBounds(elevation, context.signal);
      } catch (error) {
        if (disposed || context?.signal.aborted) return;
        report(error);
        heightBounds = createHeightBounds(elevation);
      }
      if (disposed || context?.signal.aborted) return;
      terrain.setElevation(elevation);
      stats.elevationStatus = "Global elevation · true scale";
    } else {
      stats.elevationStatus = "Elevation unavailable";
      requestRender();
      return;
    }
    if (disposed || context?.signal.aborted) return;
    const altitude = camera.position.length() - radius - groundHeight();
    stats.elevationAvailable = true;
    elevationEnabled = true;
    updateElevationBounds();
    previousQuery = undefined;
    camera.position.setLength(radius + groundHeight() + altitude);
    requestRender();
  }
  async function loadOptionalData() {
    try {
      await loadData();
    } catch (error) {
      if (!disposed && !context.signal.aborted) {
        report(error);
        stats.elevationStatus = "Elevation unavailable";
        requestRender();
      }
    }
  }
  const surface = {
    id: "tiled-surface",
    stats,
    get ready() {
      return ready;
    },
    attach,
    update,
    prepare(now: number) {
      heightTiles?.advance(now);
    },
    sampleHeight: sampleSurfaceHeight,
    setSurfaceLayer(layer: SurfaceLayer) {
      terrain.setSurfaceLayer(layer);
      requestRender();
    },
    setNormalCacheEnabled(enabled: boolean) {
      terrain.setNormalCacheEnabled(enabled);
      requestRender();
    },
    setSunlightCacheEnabled(enabled: boolean) {
      terrain.setSunlightCacheEnabled(enabled);
      requestRender();
    },
    setHapke(enabled: boolean) {
      terrain.setHapkeEnabled(enabled);
      requestRender();
    },
    setTerrainShadows(enabled: boolean) {
      terrain.setTerrainShadows(enabled);
      requestRender();
    },
    setShadowSteps(steps: number) {
      terrain.setShadowSteps(steps);
      requestRender();
    },
    setShading(enabled: boolean) {
      terrain.setShadingEnabled(enabled);
      requestRender();
    },
    setWireframe(enabled: boolean) {
      terrain.setWireframe(enabled);
      requestRender();
    },
    setElevationEnabled(enabled: boolean) {
      elevationEnabled = enabled && stats.elevationAvailable;
      updateElevationBounds();
      terrain.setElevationEnabled(elevationEnabled);
      previousQuery = undefined;
      requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      finishReady();
      heightTiles?.dispose();
      imagery?.dispose();
      if (terrain!) {
        terrain.group.removeFromParent();
        terrain.dispose();
      } else {
        overview?.dispose();
        nightLights?.dispose();
      }
    },
  };
  return surface satisfies GlobeSurface;
}
export type TiledSurface = ReturnType<typeof tiledSurface>;
