import * as THREE from "three/webgpu";
import type { TerrainCacheOptions } from "./rendering/terrain-cache-state.ts";
import type { TerrainCacheStats } from "./rendering/terrain-compute.ts";
import { VIEW } from "./tiles/lod.ts";
import { createCameraView } from "./camera-view.ts";
import { placeChildren } from "./placement.ts";
import { resolveHeights, resolveImagery, type SourceContext } from "./sources.ts";
import { selectAdaptiveTiles } from "./tiles/quadtree.ts";
import { createTileProducer } from "./tile-producer.ts";
import { MAX_LEVEL, ROOT_COUNT } from "./tiles/roots.ts";
import { createTileInstances, type TileInstances } from "./rendering/tile-instances.ts";
import {
  createTileLayer,
  type SurfaceLayer,
  type TerrainSettings,
} from "./rendering/tile-layer.ts";

export type { SurfaceLayer };
import { geographicToDirection } from "./geographic.ts";
import { altitudeOf, ellipsoidDistance, ellipsoidOffset, toSphere } from "./ellipsoid.ts";
import type { WmtsImagery } from "./imagery/wmts.ts";
import type { ImagerySource } from "./imagery/source.ts";
import { loadRegionalCatalog } from "./imagery/regions.ts";
import type { HeightSource } from "./elevation/source.ts";
import { removeLabelElements, type GlobeLabel } from "./globe-label.ts";
import type { Atmosphere } from "./atmosphere/atmosphere.ts";
import type { SurfaceOverlay } from "./overlay.ts";
import type { TerrainMask } from "./terrain-mask.ts";

/** What to build a {@link TiledGlobe} from. Every dataset is optional. */
export interface TiledGlobeOptions {
  /** Equatorial radius in meters (the globe's local units). */
  radius: number;
  /**
   * Polar flattening, such as 1 / 298.257223563 for WGS84 Earth. Latitudes are then
   * geodetic and altitudes are above the ellipsoid. Defaults to a sphere.
   */
  flattening?: number;
  /** Body name. When set, manifests published for another body are rejected. */
  name?: string;
  /**
   * Equirectangular sRGB overview, drawn where tiled imagery has not loaded. Without
   * either the terrain is neutral. A supplied texture transfers ownership.
   */
  overview?: string | THREE.Texture;
  /** Equirectangular sRGB night lights. A supplied texture transfers ownership. */
  nightLights?: string | THREE.Texture;
  /**
   * Equirectangular water fraction in the red channel (1 open water, 0 land), north
   * row first. Water gets sun glint and reflected sky. A texture transfers ownership.
   */
  waterMask?: string | THREE.Texture;
  /**
   * Imagery tile manifest URL, a WMTS service, or any {@link ImagerySource}. Like all URLs
   * here, a manifest resolves against `document.baseURI`. A source transfers ownership.
   */
  imagery?: string | WmtsImagery | ImagerySource;
  /** Sparse regional imagery catalog URL. */
  regions?: string;
  /** Height-tile manifest URL, or any {@link HeightSource}. A source transfers ownership. */
  elevation?: string | HeightSource;
  /**
   * Light the terrain from this light: a DirectionalLight's direction, or the
   * direction toward a PointLight (a Sun at the center of a solar-system scene).
   * Defaults to a fixed direction.
   */
  sun?: THREE.DirectionalLight | THREE.PointLight | null;
  /** Lunar-style Hapke reflectance instead of Lambert. An illustrative preset, not a fitted one. */
  hapke?: boolean;
  /**
   * Light everywhere, on top of the sun, so a drawn map stays readable at night. 1 is as
   * bright as the noon sun. Defaults to 0.
   */
  ambient?: number;
  /** Ground-locked grain where resident imagery is magnified past its texels. */
  surfaceDetail?: boolean;
  /** Grid cells along a tile's edge, 2 to 128. Defaults to 32. */
  gridSegments?: number;
  /** Most tiles drawn at once, 6 to 65536. Defaults to 2048. */
  tileCapacity?: number;
  /** Deepest quadtree level, up to 20. Defaults to 20. */
  maxLevel?: number;
  /** Refine a tile until its grid cells are this many pixels across. Defaults to 12. */
  maxCellPixels?: number;
  /** Resident imagery tiles, 6 to 255. This bounds GPU memory at any depth. Defaults to 255. */
  imagerySlots?: number;
  /** Resident height tiles, 6 to 255. Defaults to 128. */
  heightSlots?: number;
  /** Budgets for the terrain's derived GPU caches. */
  caches?: TerrainCacheOptions;
}

/** What the globe drew last frame, much like `renderer.info`. */
export interface TiledGlobeStats {
  /** Tiles drawn. */
  tiles: number;
  /** Triangles drawn. */
  triangles: number;
  /** Finest quadtree level drawn. */
  deepestLevel: number;
  /** CPU time spent selecting tiles. */
  selectionMs: number;
  /** Tiled imagery loaded its manifest. */
  imageryAvailable: boolean;
  /** Tiled elevation loaded its manifest. */
  elevationAvailable: boolean;
  /** Imagery state, for display. */
  imageryStatus: string;
  /** Elevation state, for display. */
  elevationStatus: string;
  /** Derived GPU caches, once elevation has loaded. */
  terrainCaches?: Readonly<TerrainCacheStats>;
  /** Every tile the last update wanted has arrived or failed, and no fade is running. */
  loaded: boolean;
}

/** A displayed height and where it came from. */
export interface HeightSample {
  /** Meters above `verticalDatum`, as drawn. */
  height: number;
  /** What height 0 is: the dataset's `verticalDatum`, or `ellipsoid` without elevation. */
  verticalDatum: string;
  /** Dataset level of the finest height tile in the sample. Undefined where none is drawn. */
  level: number | undefined;
  /** North-south meters between that tile's samples. Undefined where none is drawn. */
  spacing: number | undefined;
}

/** Events a {@link TiledGlobe} dispatches. */
export interface TiledGlobeEventMap extends THREE.Object3DEventMap {
  /** Streaming, a fade or a setting needs another frame; render again. */
  change: object;
  /**
   * The view has fully loaded: every wanted tile arrived or failed and fades finished. The
   * frame rendered after this update is complete. Fires again after the next change of view.
   */
  loaded: object;
  /** A failed download or GPU job. Never fatal. Without a listener it is logged. */
  error: {
    /** What went wrong. */
    error: unknown;
  };
}

const _normal = new THREE.Vector3(),
  _globeQuaternion = new THREE.Quaternion(),
  _bufferSize = new THREE.Vector2(),
  _inverse = new THREE.Matrix4(),
  _ray = new THREE.Ray(),
  _point = new THREE.Vector3(),
  _target = new THREE.Vector3();

/**
 * A planetary body with streamed, tiled imagery and elevation.
 *
 * Add it to a scene like any Object3D, and call `update(camera, renderer)` once per frame
 * before rendering. Loading starts in the constructor. Listen for `change` to render on
 * demand while tiles stream in. Failures are non-fatal: see {@link TiledGlobeEventMap}.
 *
 * Its local frame is body-fixed: +Y north, +X longitude zero, −Z longitude 90° east, in
 * meters. Children ride the surface. Move or rotate it freely, but keep it unscaled.
 *
 * Tiles follow latitude and longitude, with polar stereographic caps above 80° so the
 * poles stay square. Data comes from prepared manifests or, with {@link WmtsImagery},
 * straight from a tile service.
 *
 * Add an {@link Atmosphere}, {@link Clouds}, overlays and {@link GlobeLabel}s as children.
 * The globe drives them, but each that has `dispose()` is yours to dispose.
 *
 * @example
 * ```ts
 * const moon = new TiledGlobe({
 *   name: "Moon",
 *   radius: 1_737_400,
 *   overview: "/moon-2k.jpg",
 *   imagery: "/data/moon/wac/manifest.json",
 *   elevation: "/data/moon/elevation-tiles/manifest.json",
 *   sun: directionalLight,
 *   hapke: true,
 * });
 * scene.add(moon);
 * ```
 */
export class TiledGlobe extends THREE.Object3D<TiledGlobeEventMap> {
  /** @internal */
  readonly isTiledGlobe = true;
  override readonly type = "TiledGlobe";
  /** Equatorial radius in meters. */
  readonly radius: number;
  /**
   * Polar flattening; 0 is a sphere. On a flattened globe a point's direction from the
   * center is not its surface normal, so use {@link normalAt}.
   */
  readonly flattening: number;
  /** Light whose direction shades the terrain. */
  sun: THREE.DirectionalLight | THREE.PointLight | null;
  /** What was drawn last frame. */
  readonly stats: TiledGlobeStats;
  /** Settles after initial imagery and elevation setup, or its reported failure. Tiles keep streaming. */
  readonly ready: Promise<void>;
  #terrain: ReturnType<typeof createTerrain>;

  constructor(options: TiledGlobeOptions) {
    super();
    if (!Number.isFinite(options.radius) || options.radius <= 0)
      throw new RangeError("A globe requires a positive radius.");
    if (!(options.flattening === undefined || (options.flattening >= 0 && options.flattening < 1)))
      throw new RangeError("Flattening must be from 0 to below 1.");
    this.radius = options.radius;
    this.flattening = options.flattening ?? 0;
    this.name = options.name ?? "";
    this.sun = options.sun ?? null;
    this.#terrain = createTerrain(this, options);
    this.stats = this.#terrain.stats;
    this.ready = this.#terrain.ready;
  }

  /** Surface shown: tiled `imagery`, the `overview` image, neutral `terrain`, or a `checker`. */
  get display(): SurfaceLayer {
    return this.#terrain.settings.layer ?? "terrain";
  }
  set display(value: SurfaceLayer) {
    this.#terrain.set({ layer: value });
  }
  /** Sun lighting. Off shows unlit imagery. */
  get shading() {
    return this.#terrain.settings.shading;
  }
  set shading(value: boolean) {
    this.#terrain.set({ shading: value });
  }
  /** Shadows cast by loaded elevation. */
  get terrainShadows() {
    return this.#terrain.settings.shadows;
  }
  set terrainShadows(value: boolean) {
    this.#terrain.set({ shadows: value });
  }
  /** Shadow ray-march steps, clamped to 8..48. */
  get shadowSteps() {
    return this.#terrain.settings.shadowSteps;
  }
  set shadowSteps(value: number) {
    this.#terrain.set({ shadowSteps: value });
  }
  /** Lunar-style Hapke reflectance instead of Lambert. */
  get hapke() {
    return this.#terrain.settings.hapke;
  }
  set hapke(value: boolean) {
    this.#terrain.set({ hapke: value });
  }
  /** Light everywhere, on top of the sun. See {@link TiledGlobeOptions.ambient}. */
  get ambient() {
    return this.#terrain.settings.ambient;
  }
  set ambient(value: number) {
    this.#terrain.set({ ambient: value });
  }
  /** Draw the tile grid. */
  get wireframe() {
    return this.#terrain.settings.wireframe;
  }
  set wireframe(value: boolean) {
    this.#terrain.set({ wireframe: value });
  }
  /** Displace the surface by loaded elevation. */
  get displacement() {
    return this.#terrain.settings.elevation;
  }
  set displacement(value: boolean) {
    this.#terrain.set({ elevation: value });
  }

  /** Select and stream tiles for this camera. Call once per frame, before rendering. */
  update(camera: THREE.PerspectiveCamera, renderer: THREE.WebGPURenderer): void {
    const height = renderer.getDrawingBufferSize(_bufferSize).y;
    this.#terrain.update(camera, renderer, height, performance.now());
  }

  /** Displayed terrain height, in meters above the ellipsoid, at a surface normal. Not a position: see {@link normalAt}. */
  heightAt(direction: THREE.Vector3): number {
    return this.#terrain.heightAt(direction.x, direction.y, direction.z);
  }

  /** {@link heightAt}, with its vertical datum and the resolution of the tile it came from. */
  sampleHeight(direction: THREE.Vector3): HeightSample {
    return this.#terrain.sampleHeight(direction.x, direction.y, direction.z);
  }

  /** Point on the displayed terrain, plus `altitude`, in the globe's local frame. */
  positionAt(
    latitudeDeg: number,
    longitudeDeg: number,
    altitude = 0,
    target = new THREE.Vector3(),
  ) {
    geographicToDirection(latitudeDeg, longitudeDeg, _normal);
    return ellipsoidOffset(_normal, this.radius, this.flattening, target).addScaledVector(
      _normal,
      this.radius + this.heightAt(_normal) + altitude,
    );
  }

  /** Surface normal beneath a point in the globe's local frame. */
  normalAt(point: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    return toSphere(point, this.radius, this.flattening, target).normalize();
  }

  /** Height of a local point above the ellipsoid, ignoring terrain. */
  altitudeOf(point: THREE.Vector3): number {
    return altitudeOf(point, this.radius, this.flattening);
  }

  /** Intersects the displayed surface, so `raycaster.intersectObject(globe)` works. Children are not tested. */
  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    _inverse.copy(this.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_inverse);
    _ray.direction.normalize();
    // Intersect the sphere, then refine against the height under each estimate.
    let distance: number | undefined,
      height = 0;
    for (let i = 0; i < 4; i++) {
      distance = ellipsoidDistance(_ray, this.radius + height, this.flattening);
      if (distance === undefined) return;
      height = this.heightAt(this.normalAt(_ray.at(distance, _point), _normal));
    }
    _ray.at(distance!, _point).applyMatrix4(this.matrixWorld);
    const world = raycaster.ray.origin.distanceTo(_point);
    if (world < raycaster.near || world > raycaster.far) return;
    intersects.push({ distance: world, point: _point.clone(), object: this });
  }

  /** Cancel downloads, release GPU resources and remove its labels from the page. Idempotent. */
  dispose(): void {
    this.#terrain.dispose();
    removeLabelElements(this);
    this.removeFromParent();
  }

  /** Removing a parent does not remove a CSS2D element's node. Take those off the page too. */
  override remove(...objects: THREE.Object3D[]): this {
    for (const object of objects) {
      removeLabelElements(object);
      super.remove(object);
    }
    return this;
  }

  /** Direction toward the sun in the local frame. @internal */
  sunDirection(out: THREE.Vector3): THREE.Vector3 {
    if (!this.sun) return geographicToDirection(0, 90, out); // Over longitude 90° east.
    this.sun.updateWorldMatrix(true, false);
    const from =
      "target" in this.sun
        ? (this.sun.target.updateWorldMatrix(true, false), this.sun.target)
        : this;
    this.sun.getWorldPosition(out).sub(from.getWorldPosition(_target));
    this.getWorldQuaternion(_globeQuaternion).invert();
    return out.applyQuaternion(_globeQuaternion).normalize();
  }
}

// The display default depends on which data loads, so `layer` is chosen once loaded.
type Settings = Omit<TerrainSettings, "layer"> & Partial<Pick<TerrainSettings, "layer">>;

function createTerrain(globe: TiledGlobe, options: TiledGlobeOptions) {
  const radius = globe.radius;
  const flattening = globe.flattening;
  const body = options.name ? { name: options.name, radiusMeters: radius } : undefined;
  const controller = new AbortController(),
    signal = controller.signal;
  const segments = options.gridSegments ?? 32,
    capacity = options.tileCapacity ?? 2048;
  const maxLevel = options.maxLevel ?? MAX_LEVEL,
    cellPixels = options.maxCellPixels ?? 12;
  if (
    !Number.isInteger(segments) ||
    segments < 2 ||
    segments > 128 ||
    !Number.isInteger(capacity) ||
    capacity < ROOT_COUNT ||
    capacity > 65536 ||
    !Number.isInteger(maxLevel) ||
    maxLevel < 0 ||
    maxLevel > MAX_LEVEL ||
    !Number.isFinite(cellPixels) ||
    cellPixels <= 0
  )
    throw new RangeError("Invalid tiled globe settings");
  const url = (path: string) => new URL(path, document.baseURI).href;
  const changed = () => {
    if (!signal.aborted) globe.dispatchEvent({ type: "change" });
  };
  const report = (error: unknown) => {
    if (signal.aborted) return;
    if (hasListeners(globe, "error")) globe.dispatchEvent({ type: "error", error });
    else console.warn("[TiledGlobe]", error);
  };

  const cameraView = createCameraView({ radius, flattening, segments, maxLevel, cellPixels }),
    view = cameraView.view,
    sun = new THREE.Vector3();

  const settings: Settings = {
    shading: true,
    shadows: true,
    shadowSteps: 24,
    hapke: options.hapke ?? false,
    ambient: options.ambient ?? 0,
    wireframe: false,
    elevation: true,
  };
  let previousQuery: Float64Array | undefined, previousInstances: TileInstances | undefined;
  const shownHeights = () => (settings.elevation ? terrain?.heights : undefined);
  const stats: TiledGlobeStats = {
    tiles: 0,
    triangles: 0,
    deepestLevel: 0,
    selectionMs: 0,
    imageryAvailable: false,
    elevationAvailable: false,
    imageryStatus: "Loading",
    elevationStatus: options.elevation ? "Waiting for imagery" : "No elevation configured",
    loaded: false,
  };
  const produce = createTileProducer(capacity, (tiles, query) =>
    selectAdaptiveTiles(tiles, query, shownHeights()),
  );
  const heightAt = (x: number, y: number, z: number) =>
    shownHeights()?.sampleDirection(x, y, z) ?? 0;
  function sampleHeight(x: number, y: number, z: number): HeightSample {
    const heights = shownHeights();
    if (!heights)
      return { height: 0, verticalDatum: "ellipsoid", level: undefined, spacing: undefined };
    const { height, level, angle } = heights.sampleSource(x, y, z);
    return {
      height,
      verticalDatum: heights.source.verticalDatum,
      level,
      spacing: angle === undefined ? undefined : angle * radius,
    };
  }

  let overview: THREE.Texture | undefined,
    nightLights: THREE.Texture | undefined,
    waterMask: THREE.Texture | undefined,
    terrain: ReturnType<typeof createTileLayer> | undefined,
    dataset: Awaited<ReturnType<typeof resolveImagery>>["dataset"];
  const context: SourceContext = { url, body, signal, report };

  // The terrain disposes these once it exists. A cancel before that has to free them,
  // including when dispose ran during the load and the texture arrives afterwards.
  function releasePendingTextures() {
    if (terrain) return;
    overview?.dispose();
    nightLights?.dispose();
    waterMask?.dispose();
    overview = nightLights = waterMask = undefined;
  }

  async function loadTexture(
    source: string | THREE.Texture | undefined,
    wrap: boolean,
    color = true,
  ) {
    if (typeof source !== "string") return source;
    const texture = await new THREE.TextureLoader().loadAsync(url(source));
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.flipY = false;
    if (wrap) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
    }
    return texture;
  }

  async function loadSurface() {
    overview = await loadTexture(options.overview, false).catch((error: unknown) => {
      report(error);
      return undefined;
    });
    nightLights = await loadTexture(options.nightLights, true).catch((error: unknown) => {
      report(error);
      return undefined;
    });
    waterMask = await loadTexture(options.waterMask, true, false).catch((error: unknown) => {
      report(error);
      return undefined;
    });
    if (signal.aborted) return releasePendingTextures();
    // Without tiled imagery the globe still draws its overview (or neutral terrain).
    const resolved = await resolveImagery(options.imagery, context);
    const imagerySource = resolved.source;
    dataset = resolved.dataset;
    if (signal.aborted) return releasePendingTextures();
    terrain = createTileLayer({
      radiusMeters: radius,
      segments,
      instances: createTileInstances(capacity),
      overview,
      imagery: imagerySource,
      imagerySlots: options.imagerySlots,
      caches: options.caches,
      nightLights,
      waterMask,
      surfaceDetail: options.surfaceDetail,
      flattening,
      requestRender: changed,
      report,
    });
    // Picking goes through the globe's own raycast, not the instanced grid.
    terrain.group.traverse((object) => (object.raycast = () => {}));
    settings.layer ??= terrain.hasImagery ? "imagery" : overview ? "overview" : "terrain";
    const { elevation: _elevation, ...display } = settings;
    terrain.set({ ...display, layer: settings.layer, elevation: false });
    globe.add(terrain.group);
    stats.imageryAvailable = terrain.hasImagery;
    stats.imageryStatus = imageryStatus();
    changed();
  }

  async function loadOptionalData() {
    if (options.regions && terrain?.hasImagery && dataset) {
      const { manifest, source: regional } = dataset;
      void loadRegionalCatalog(url(options.regions), manifest, signal)
        .then((catalog) => {
          if (signal.aborted || !catalog) return;
          regional.setRegions(catalog, url(options.regions!));
          terrain?.refreshImagery();
        })
        .catch(report);
    }
    if (!options.elevation || !terrain) return;
    stats.elevationStatus = "Loading elevation";
    changed();
    const heights = await resolveHeights(options.elevation, flattening, context);
    if (signal.aborted) return;
    if (!heights) {
      stats.elevationStatus = "Elevation unavailable";
      changed();
      return;
    }
    terrain.setHeights(heights, options.heightSlots ?? 128, () => {
      previousQuery = undefined;
      changed();
    });
    stats.elevationAvailable = true;
    applyElevation();
  }

  const imageryStatus = () => terrain?.imageryStatus() ?? (overview ? "Overview" : "No imagery");

  function applyElevation() {
    cameraView.setHeights(shownHeights()?.source);
    terrain?.set({ elevation: settings.elevation });
    previousQuery = undefined;
  }

  let dataLoaded = false;
  const ready = (async () => {
    try {
      await loadSurface();
      if (!signal.aborted) await loadOptionalData();
    } catch (error) {
      report(error);
      if (stats.elevationStatus === "Loading elevation")
        stats.elevationStatus = "Elevation unavailable";
      changed();
    }
    dataLoaded = true;
  })();

  function update(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    bufferHeight: number,
    now: number,
  ) {
    if (signal.aborted || !terrain) return;
    terrain.advance(now);
    globe.sunDirection(sun);
    const reversedDepth = renderer.reversedDepthBuffer === true || camera.reversedDepth;
    cameraView.update(globe, camera, reversedDepth, bufferHeight);
    // An Atmosphere child colours the ground's sunlight and adds sky light. Found by
    // shape, not imported, so globes without one never load the atmosphere code.
    const atmosphere = globe.children.find(
      (child): child is Atmosphere => (child as Partial<Atmosphere>).isAtmosphere === true,
    );
    const light = atmosphere?.update(renderer, camera, { reversedDepth, bufferHeight }) ?? null;
    const cameraPosition = cameraView.position;
    const altitude = globe.altitudeOf(cameraPosition);
    const overlays = globe.children.filter(
      (child): child is SurfaceOverlay =>
        (child as Partial<SurfaceOverlay>).isSurfaceOverlay === true,
    );
    const overlayView = {
      altitude: Math.max(altitude, 0),
      radius,
      flattening,
      pixelRatio: renderer.getPixelRatio(),
      camera: cameraPosition,
    };
    for (const overlay of overlays) overlay.update(overlayView);
    // Masks are anchors: place them before the terrain reads where they are.
    placeChildren(globe, cameraPosition, cameraView.forward);
    const masks = globe.children.filter(
      (child): child is TerrainMask => (child as Partial<TerrainMask>).isTerrainMask === true,
    );
    const started = performance.now();
    const viewChanged = !previousQuery || view.some((v, i) => v !== previousQuery![i]);
    const instances = viewChanged ? produce(view) : previousInstances!;
    if (viewChanged) {
      previousQuery = view.slice();
      previousInstances = instances;
    }
    stats.selectionMs = performance.now() - started;
    terrain.update({
      renderer,
      instances,
      view: {
        clipFromRelative: cameraView.projectionView.elements,
        projectionScale: view[VIEW.ProjectionScale],
        now,
      },
      sun,
      altitude,
      overlays,
      masks,
      camera: cameraPosition,
      light,
    });
    stats.terrainCaches = terrain.cacheStats();
    stats.tiles = instances.count;
    stats.triangles = instances.count * segments * segments * 2;
    stats.deepestLevel = 0;
    for (let i = 0; i < instances.count; i++)
      stats.deepestLevel = Math.max(
        stats.deepestLevel,
        Math.round(Math.log2(radius / instances.sizes[i])),
      );
    stats.imageryStatus = imageryStatus();
    stats.elevationStatus = terrain.elevationStatus() ?? stats.elevationStatus;
    if (terrain.needsFrame()) changed();
    const loaded = dataLoaded && terrain.settled();
    if (loaded && !stats.loaded) globe.dispatchEvent({ type: "loaded" });
    stats.loaded = loaded;
  }

  return {
    stats,
    ready,
    settings: settings as Readonly<Settings>,
    heightAt,
    sampleHeight,
    update,
    set(next: Partial<Settings>) {
      if (next.shadowSteps !== undefined && !Number.isFinite(next.shadowSteps))
        throw new RangeError("Invalid shadow steps");
      Object.assign(settings, next);
      if (!terrain) return; // Applied once the surface loads.
      const { elevation, ...display } = next;
      terrain.set(display);
      if (elevation !== undefined) applyElevation();
      changed();
    },
    dispose() {
      if (signal.aborted) return;
      controller.abort();
      if (terrain) {
        terrain.group.removeFromParent();
        terrain.dispose();
      } else releasePendingTextures();
    },
  };
}

// EventDispatcher exposes no listener count; unhandled errors are logged instead of lost.
function hasListeners(target: THREE.EventDispatcher<TiledGlobeEventMap>, type: "error") {
  const map = (target as unknown as { _listeners?: Record<string, unknown[]> })._listeners;
  return (map?.[type]?.length ?? 0) > 0;
}
