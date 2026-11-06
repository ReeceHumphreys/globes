import * as THREE from "three/webgpu";
import type { TerrainCacheOptions } from "./rendering/terrain-cache-state.ts";
import type { TerrainCacheStats } from "./rendering/terrain-compute.ts";
import { createSelectionView, VIEW } from "./tiles/lod.ts";
import { selectAdaptiveTiles } from "./tiles/quadtree.ts";
import { createTileProducer } from "./tile-producer.ts";
import { createTileInstances, type TileInstances } from "./rendering/tile-instances.ts";
import {
  createTileLayer,
  type SurfaceLayer,
  type TerrainSettings,
} from "./rendering/tile-layer.ts";

export type { SurfaceLayer };
import { geographicToDirection } from "./geographic.ts";
import { sphereDistance } from "./orbit.ts";
import { altitudeOf, ellipsoidDistance, ellipsoidOffset, toSphere } from "./ellipsoid.ts";
import { loadImageryManifest } from "./imagery/manifest.ts";
import { createImageryCache } from "./imagery/tile-cache.ts";
import { loadRegionalCatalog } from "./imagery/regions.ts";
import { loadHeightTiles } from "./elevation/tiles.ts";
import { createHeightTileCache, type HeightTileCache } from "./elevation/tile-cache.ts";
import type { GlobeLabel } from "./globe-label.ts";
import type { Atmosphere } from "./atmosphere/atmosphere.ts";
import type { SurfaceOverlay } from "./overlay.ts";

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
  /** Equirectangular sRGB overview. A supplied texture transfers ownership. */
  overview?: string | THREE.Texture;
  /** Equirectangular sRGB night lights. A supplied texture transfers ownership. */
  nightLights?: string | THREE.Texture;
  /**
   * Equirectangular water fraction in the red channel (1 open water, 0 land), north
   * row first. Water gets sun glint and reflected sky. A texture transfers ownership.
   */
  waterMask?: string | THREE.Texture;
  /** Imagery tile manifest URL. */
  imagery?: string;
  /** Sparse regional imagery catalog URL. */
  regions?: string;
  /** Height-tile manifest URL. */
  elevation?: string;
  /**
   * Light the terrain from this light: a DirectionalLight's direction, or the
   * direction toward a PointLight (a Sun at the center of a solar-system scene).
   * Defaults to a fixed direction.
   */
  sun?: THREE.DirectionalLight | THREE.PointLight | null;
  /** Lunar-style Hapke reflectance instead of Lambert. */
  hapke?: boolean;
  /** Ground-locked grain where resident imagery is magnified past its texels. */
  surfaceDetail?: boolean;
  gridSegments?: number;
  tileCapacity?: number;
  maxLevel?: number;
  maxCellPixels?: number;
  imagerySlots?: number;
  heightSlots?: number;
  caches?: TerrainCacheOptions;
}

export interface TiledGlobeStats {
  tiles: number;
  triangles: number;
  deepestLevel: number;
  selectionMs: number;
  imageryAvailable: boolean;
  elevationAvailable: boolean;
  imageryStatus: string;
  elevationStatus: string;
  terrainCaches?: Readonly<TerrainCacheStats>;
}

export interface TiledGlobeEventMap extends THREE.Object3DEventMap {
  /** Streaming or a fade needs another frame; render again. */
  change: object;
  /** A non-fatal load failure. Without a listener it is logged. */
  error: { error: unknown };
}

const _sphereCamera = new THREE.Vector3(),
  _normal = new THREE.Vector3(),
  _cameraQuaternion = new THREE.Quaternion(),
  _globeQuaternion = new THREE.Quaternion(),
  _bufferSize = new THREE.Vector2(),
  _inverse = new THREE.Matrix4(),
  _ray = new THREE.Ray(),
  _point = new THREE.Vector3(),
  _toward = new THREE.Vector3(),
  _target = new THREE.Vector3();

/**
 * A spherical body with streamed, tiled imagery and elevation.
 *
 * Add it to a scene like any Object3D. Its local frame is body-fixed: +Y north,
 * +X longitude zero, −Z longitude 90° east, in meters. Children ride the surface.
 * Call `update(camera, renderer)` once per frame before rendering; listen for
 * `change` to render on demand while tiles stream in.
 */
export class TiledGlobe extends THREE.Object3D<TiledGlobeEventMap> {
  readonly isTiledGlobe = true;
  override readonly type = "TiledGlobe";
  readonly radius: number;
  readonly flattening: number;
  /** Light whose direction shades the terrain. */
  sun: THREE.DirectionalLight | THREE.PointLight | null;
  readonly stats: TiledGlobeStats;
  /** Settles after the initial imagery and elevation setup, or its reported failure. */
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

  /** Displayed terrain height, in meters above the ellipsoid, at a surface normal. */
  heightAt(direction: THREE.Vector3): number {
    return this.#terrain.heightAt(direction.x, direction.y, direction.z);
  }

  /** Point at a geographic position, in the globe's local frame. */
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

  /** Intersects the displayed surface. Children are not tested. */
  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    _inverse.copy(this.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_inverse);
    _ray.direction.normalize();
    // Intersect the sphere, then refine against the height under each estimate.
    let distance: number | undefined,
      height = 0;
    for (let i = 0; i < 4; i++) {
      distance = ellipsoidDistance(_ray, this.radius + height, this.flattening, sphereDistance);
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
    // CSS2DObjects remove their element only when they themselves are removed,
    // not when an ancestor is; take this globe's labels off the page too.
    this.traverse((object) => {
      if ("isCSS2DObject" in object) (object as unknown as { element: Element }).element.remove();
    });
    this.removeFromParent();
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

  const view = createSelectionView();
  view[VIEW.Radius] = radius;
  view[VIEW.Segments] = segments;
  view[VIEW.MaxLevel] = maxLevel;
  view[VIEW.MaxCellPixels] = cellPixels;
  view[VIEW.Cull] = 1;
  const relativeCamera = new THREE.PerspectiveCamera(),
    frustum = new THREE.Frustum(),
    projectionView = new THREE.Matrix4(),
    sun = new THREE.Vector3(),
    cameraForward = new THREE.Vector3(),
    cameraPosition = new THREE.Vector3();
  function updateView(camera: THREE.PerspectiveCamera, reversedDepth: boolean, height: number) {
    camera.updateMatrixWorld(true);
    globe.updateMatrixWorld(true);
    // Selection runs in the globe's frame: camera position and rotation relative to it.
    globe.worldToLocal(camera.getWorldPosition(cameraPosition));
    globe.getWorldQuaternion(_globeQuaternion).invert();
    relativeCamera.quaternion.multiplyQuaternions(
      _globeQuaternion,
      camera.getWorldQuaternion(_cameraQuaternion),
    );
    relativeCamera.projectionMatrix.copy(camera.projectionMatrix);
    relativeCamera.updateMatrixWorld(true);
    relativeCamera.getWorldDirection(cameraForward);
    projectionView.multiplyMatrices(
      relativeCamera.projectionMatrix,
      relativeCamera.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(projectionView, THREE.WebGPUCoordinateSystem, reversedDepth);
    // Selection sees the sphere, with the camera at its height over the matching point.
    // That is exact beneath the camera and drifts with distance, by less than this.
    toSphere(cameraPosition, radius, flattening, _sphereCamera);
    const planeSlack = Math.min(
      radius * flattening,
      Math.max(0, _sphereCamera.length() - radius) * 0.02,
    );
    for (let i = 0; i < 6; i++) {
      const plane = frustum.planes[i];
      view.set(
        [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant + planeSlack],
        VIEW.Planes + i * 4,
      );
    }
    view[VIEW.CameraX] = _sphereCamera.x;
    view[VIEW.CameraY] = _sphereCamera.y;
    view[VIEW.CameraZ] = _sphereCamera.z;
    view[VIEW.ProjectionScale] = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }

  let heightTiles: HeightTileCache | undefined;
  const settings: Settings = {
    shading: true,
    shadows: true,
    shadowSteps: 24,
    hapke: options.hapke ?? false,
    wireframe: false,
    elevation: true,
  };
  let previousQuery: Float64Array | undefined, previousInstances: TileInstances | undefined;
  const shownHeights = () => (settings.elevation ? heightTiles : undefined);
  const stats: TiledGlobeStats = {
    tiles: 0,
    triangles: 0,
    deepestLevel: 0,
    selectionMs: 0,
    imageryAvailable: false,
    elevationAvailable: false,
    imageryStatus: "Loading",
    elevationStatus: options.elevation ? "Waiting for imagery" : "No elevation configured",
  };
  const produce = createTileProducer(capacity, (tiles, query) =>
    selectAdaptiveTiles(tiles, query, shownHeights()),
  );
  const heightAt = (x: number, y: number, z: number) =>
    shownHeights()?.sampleDirection(x, y, z) ?? 0;
  function updateElevationBounds() {
    const field = shownHeights()?.manifest;
    // The horizon test needs a sphere inside the surface, so it allows for the flattening.
    view[VIEW.MinElevation] = (field ? Math.min(0, field.minMeters) : 0) - radius * flattening;
    view[VIEW.MaxElevation] = field ? Math.max(0, field.maxMeters) : 0;
  }

  let overview: THREE.Texture | undefined,
    nightLights: THREE.Texture | undefined,
    waterMask: THREE.Texture | undefined,
    imagery: ReturnType<typeof createImageryCache> | undefined,
    terrain: ReturnType<typeof createTileLayer> | undefined,
    manifest: Awaited<ReturnType<typeof loadImageryManifest>> | undefined;

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
    if (signal.aborted) return;
    const manifestURL = options.imagery ? url(options.imagery) : undefined;
    if (manifestURL)
      // Without tiled imagery the globe still draws its overview (or neutral terrain).
      manifest = await loadImageryManifest(manifestURL, body, signal).catch((error) => {
        report(error);
        return undefined;
      });
    if (signal.aborted) return;
    if (manifest && manifestURL)
      imagery = createImageryCache(
        manifest,
        manifestURL,
        capacity,
        changed,
        undefined,
        options.imagerySlots ?? 128,
        { onError: report },
      );
    terrain = createTileLayer({
      radiusMeters: radius,
      segments,
      instances: createTileInstances(capacity),
      overview,
      imagery,
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
    settings.layer ??= manifest ? "imagery" : overview ? "overview" : "terrain";
    const { elevation: _elevation, ...display } = settings;
    terrain.set({ ...display, layer: settings.layer, elevation: false });
    globe.add(terrain.group);
    stats.imageryAvailable = !!imagery;
    stats.imageryStatus = imagery?.status() ?? (overview ? "Overview" : "No imagery");
    changed();
  }

  async function loadOptionalData() {
    if (options.regions && imagery && manifest) {
      void loadRegionalCatalog(url(options.regions), manifest, signal)
        .then((catalog) => {
          if (!signal.aborted && catalog) imagery!.setRegions(catalog, url(options.regions!));
        })
        .catch(report);
    }
    if (!options.elevation || !terrain) return;
    stats.elevationStatus = "Loading elevation";
    changed();
    const heightsURL = url(options.elevation);
    const heightManifest = await loadHeightTiles(heightsURL, signal, body).catch((error) => {
      report(error);
      return undefined;
    });
    if (signal.aborted) return;
    if (!heightManifest) {
      stats.elevationStatus = "Elevation unavailable";
      changed();
      return;
    }
    heightTiles = createHeightTileCache(
      heightManifest,
      heightsURL,
      capacity,
      () => {
        previousQuery = undefined;
        changed();
      },
      undefined,
      options.heightSlots ?? 64,
      { onError: report },
    );
    terrain.setHeightTiles(heightTiles);
    stats.elevationAvailable = true;
    applyElevation();
  }

  function applyElevation() {
    updateElevationBounds();
    terrain?.set({ elevation: settings.elevation });
    previousQuery = undefined;
  }

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
  })();

  function update(
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGPURenderer,
    bufferHeight: number,
    now: number,
  ) {
    if (signal.aborted || !terrain) return;
    heightTiles?.advance(now);
    globe.sunDirection(sun);
    const reversedDepth = renderer.reversedDepthBuffer === true || camera.reversedDepth;
    updateView(camera, reversedDepth, bufferHeight);
    // An Atmosphere child colours the ground's sunlight and adds sky light. Found by
    // shape, not imported, so globes without one never load the atmosphere code.
    const atmosphere = globe.children.find(
      (child): child is Atmosphere => (child as Partial<Atmosphere>).isAtmosphere === true,
    );
    const light = atmosphere?.update(renderer, camera, { reversedDepth, bufferHeight }) ?? null;
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
    const started = performance.now();
    const viewChanged =
      previousInstances?.buffer.byteLength === 0 ||
      !previousQuery ||
      view.some((v, i) => v !== previousQuery![i]);
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
        clipFromRelative: projectionView.elements,
        projectionScale: view[VIEW.ProjectionScale],
        now,
      },
      sun,
      altitude,
      overlays,
      light,
    });
    stats.terrainCaches = terrain.cacheStats();
    stats.tiles = instances.count;
    stats.triangles = instances.count * segments * segments * 2;
    stats.deepestLevel = 0;
    for (let i = 0; i < instances.count; i++)
      stats.deepestLevel = Math.max(
        stats.deepestLevel,
        Math.round(Math.log2(radius / instances.sizes[i * 2])),
      );
    stats.imageryStatus = imagery?.status() ?? (overview ? "Overview" : "No imagery");
    if (heightTiles) stats.elevationStatus = heightTiles.status();
    placeLabels(globe);
    if (imagery?.needsFrame() || heightTiles?.needsFrame()) changed();
  }

  // Lift labels onto the terrain and hide those behind the horizon. A hidden
  // parent hides its labels, so only visible branches are walked.
  const labelPoint = new THREE.Vector3();
  function placeLabels(object: THREE.Object3D) {
    for (const child of object.children) {
      if ((child as GlobeLabel).isGlobeLabel) {
        const label = child as GlobeLabel;
        const { latitude, longitude, altitude } = label;
        const ground =
          label.altitudeReference === "ellipsoid"
            ? globe.heightAt(geographicToDirection(latitude, longitude, labelPoint))
            : 0;
        globe.positionAt(latitude, longitude, altitude - ground, label.position);
        labelPoint.copy(label.position).normalize();
        const toCamera = _toward.copy(cameraPosition).sub(label.position);
        label.visible =
          labelPoint.dot(toCamera) > 0 && // above the horizon
          toCamera.dot(cameraForward) < 0; // in front of the camera
      } else if (child.visible) placeLabels(child);
    }
  }

  return {
    stats,
    ready,
    settings: settings as Readonly<Settings>,
    heightAt,
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
      heightTiles?.dispose();
      imagery?.dispose();
      if (terrain) {
        terrain.group.removeFromParent();
        terrain.dispose();
      } else {
        overview?.dispose();
        nightLights?.dispose();
        waterMask?.dispose();
      }
    },
  };
}

// EventDispatcher exposes no listener count; unhandled errors are logged instead of lost.
function hasListeners(target: THREE.EventDispatcher<TiledGlobeEventMap>, type: "error") {
  const map = (target as unknown as { _listeners?: Record<string, unknown[]> })._listeners;
  return (map?.[type]?.length ?? 0) > 0;
}
