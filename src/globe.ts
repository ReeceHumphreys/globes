import * as THREE from "three/webgpu";
import { validateBody, type GlobeBody } from "./body.ts";
import { createOrbitInput, type CameraFocus } from "./controls.ts";
import {
  sunDirection,
  DEFAULT_SUN_LONGITUDE_DEG,
  DEFAULT_SUN_LATITUDE_DEG,
} from "./rendering/sun.ts";
import { tiledSurface, type TiledSurfaceOptions, type TiledSurface } from "./tiled-surface.ts";
import { createLayerHost } from "./layer-host.ts";
import type {
  GlobeContext,
  GlobeLayer,
  GlobeSurface,
  GlobeStats,
  SurfaceLayer,
  GlobeRenderPipeline,
  GlobeEnvironment,
} from "./composition.ts";
export type { GlobeStats, SurfaceLayer } from "./composition.ts";

export interface GlobeOptions extends TiledSurfaceOptions {
  container: HTMLElement;
  body: GlobeBody;
  /** Defaults to tiledSurface(options). Do not mix this with legacy terrain options. */
  surface?: GlobeSurface;
  layers?: readonly GlobeLayer[];
  /** Attached first and disposed last, shared by surface and all scene layers. */
  environment?: GlobeEnvironment;
  minAltitudeMeters?: number;
  exposureStops?: number;
  onError?: (error: unknown) => void;
  /** Optional owned compositor, created after scene layers attach. */
  renderPipeline?: (context: GlobeContext) => GlobeRenderPipeline;
}

/** Shared rendering engine. Terrain, atmosphere, rings, sky, and models are compositions. */
export async function createGlobe(options: GlobeOptions) {
  validateBody(options.body);
  if (options.renderPipeline && options.environment?.createRenderPipeline)
    throw new Error("Configure the compositor on either environment or renderPipeline, not both");
  if (!("gpu" in navigator)) throw new Error("This globe requires WebGPU on HTTPS or localhost.");
  const body = Object.freeze({ ...options.body }),
    radius = body.radiusMeters;
  const container = options.container;
  if (!container || typeof container.appendChild !== "function")
    throw new TypeError("A container element is required");
  const minAltitude = options.minAltitudeMeters ?? 10;
  if (!Number.isFinite(minAltitude) || minAltitude <= 0)
    throw new RangeError("Invalid minimum altitude");
  if (!Number.isFinite(options.exposureStops ?? 0)) throw new RangeError("Invalid exposure");
  if (
    options.surface &&
    [
      "overview",
      "imagery",
      "regions",
      "elevation",
      "gridSegments",
      "tileCapacity",
      "maxLevel",
      "maxCellPixels",
      "imagerySlots",
      "heightSlots",
      "hapke",
      "caches",
      "lighting",
    ].some((key) => key in options)
  )
    throw new Error("Configure terrain inside tiledSurface(), not alongside surface");
  const surface = options.surface ?? tiledSurface(options);
  const controller = new AbortController();
  const report = options.onError ?? ((error: unknown) => console.warn("[TiledGlobe]", error));
  const scene = new THREE.Scene();
  const overlay = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, radius * 0.001, radius * 20);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  (camera as unknown as { _reversedDepth: boolean })._reversedDepth = true;
  camera.position.x = radius * 3;
  camera.lookAt(0, 0, 0);
  const renderer = new THREE.WebGPURenderer({ reversedDepthBuffer: true });
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 2 ** (options.exposureStops ?? 0);
  const sun = {
    longitudeDeg: DEFAULT_SUN_LONGITUDE_DEG,
    latitudeDeg: DEFAULT_SUN_LATITUDE_DEG,
    direction: new THREE.Vector3(
      ...sunDirection(
        (DEFAULT_SUN_LONGITUDE_DEG * Math.PI) / 180,
        (DEFAULT_SUN_LATITUDE_DEG * Math.PI) / 180,
      ),
    ),
  };
  const viewport = { width: 1, height: 1, pixelRatio: 1 };
  const stats: GlobeStats = {
    tiles: 0,
    triangles: 0,
    deepestLevel: 0,
    selectionMs: 0,
    altitudeMeters: radius * 2,
    imageryAvailable: false,
    elevationAvailable: false,
    imageryStatus: "Custom surface",
    elevationStatus: "No elevation",
  };
  let disposed = false,
    initialized = false,
    scheduledFrame = 0;
  let previousTime: number | undefined;
  const startedAt = performance.now();
  const listeners = new Set<(stats: Readonly<GlobeStats>) => void>();
  const sampleHeight = (x: number, y: number, z: number) => surface.sampleHeight?.(x, y, z) ?? 0;
  const groundHeight = () => sampleHeight(camera.position.x, camera.position.y, camera.position.z);
  function requestRender() {
    if (disposed || !initialized || scheduledFrame) return;
    scheduledFrame = requestAnimationFrame(() => {
      scheduledFrame = 0;
      render();
    });
  }
  const context: GlobeContext = {
    body,
    container,
    scene,
    overlay,
    camera,
    renderer,
    environment: options.environment,
    sun,
    viewport,
    signal: controller.signal,
    requestRender,
    reportError: report,
    sampleHeight,
  };
  const host = createLayerHost(context);
  let controls: ReturnType<typeof createOrbitInput> | undefined;
  let observer: ResizeObserver | undefined;
  let pipeline: GlobeRenderPipeline | undefined;
  function render() {
    if (disposed || !initialized) return;
    const now = performance.now(),
      oldGround = groundHeight();
    host.prepare(now); // The surface first, then layers: clocks advance before the camera moves.
    const ground = groundHeight();
    if (ground !== oldGround)
      camera.position.setLength(camera.position.length() + ground - oldGround);
    camera.position.setLength(Math.max(camera.position.length(), radius + ground + minAltitude));
    controls!.aim();
    // Focus can sit beside the surface. Only the body orbit keeps the minimum altitude.
    const aboveGround = radius + ground;
    camera.position.setLength(
      Math.max(
        camera.position.length(),
        aboveGround + (controls!.focusDistance === undefined ? minAltitude : 0),
      ),
    );
    const altitude = camera.position.length() - radius - ground;
    const focusDistance = controls!.focusDistance;
    camera.near = Math.max(0.1, Math.min(radius * 0.01, altitude * 0.02));
    if (focusDistance !== undefined)
      camera.near = Math.max(0.01, Math.min(camera.near, focusDistance * 0.05));
    camera.far = camera.position.length() + radius * 2;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const frame = {
      context,
      now,
      deltaSeconds: previousTime === undefined ? 0 : (now - previousTime) / 1000,
      elapsedSeconds: (now - startedAt) / 1000,
    };
    previousTime = now;
    host.update(frame); // Surface first, then optional layers in insertion order.
    Object.assign(stats, surface.stats);
    stats.altitudeMeters = altitude;
    for (const listener of listeners) {
      try {
        listener(stats);
      } catch (error) {
        report(error);
      }
    }
    if (pipeline) pipeline.render();
    else renderer.render(scene, camera);
    if (overlay.children.length) {
      // Draw straight onto the finished canvas, as RenderPipeline does: with tone mapping or
      // an output color space, render() would blit a stale internal target over the frame.
      const { toneMapping, outputColorSpace } = renderer;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlay, camera);
      renderer.autoClear = true;
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = outputColorSpace;
    }
  }
  function resize() {
    viewport.width = Math.max(1, container.clientWidth);
    viewport.height = Math.max(1, container.clientHeight);
    viewport.pixelRatio = window.devicePixelRatio || 1;
    camera.aspect = viewport.width / viewport.height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(viewport.pixelRatio);
    renderer.setSize(viewport.width, viewport.height);
    requestRender();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    if (scheduledFrame) cancelAnimationFrame(scheduledFrame);
    observer?.disconnect();
    controls?.dispose();
    listeners.clear();
    try {
      pipeline?.dispose();
    } catch (error) {
      report(error);
    }
    host.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }
  try {
    resize();
    container.appendChild(renderer.domElement);
    await renderer.init();
    if (!("isWebGPUBackend" in renderer.backend)) throw new Error("A WebGPU adapter is required.");
    if (options.environment) await host.add(options.environment);
    await host.add(surface);
    for (const layer of options.layers ?? []) await host.add(layer);
    pipeline =
      options.environment?.createRenderPipeline?.(context) ?? options.renderPipeline?.(context);
    controls = createOrbitInput(
      renderer.domElement,
      camera,
      radius,
      minAltitude,
      groundHeight,
      render,
    );
    observer = new ResizeObserver(resize);
    observer.observe(container);
    initialized = true;
    render();
  } catch (error) {
    dispose();
    throw error;
  }
  // Compatibility shorthands are delegated capabilities, not engine dependencies.
  function terrainControl<
    K extends
      | "setSurfaceLayer"
      | "setHapke"
      | "setTerrainShadows"
      | "setShadowSteps"
      | "setShading"
      | "setWireframe"
      | "setElevationEnabled"
      | "setNormalCacheEnabled"
      | "setSunlightCacheEnabled",
  >(key: K, value: Parameters<TiledSurface[K]>[0]) {
    const method = (surface as unknown as Partial<TiledSurface>)[key];
    if (typeof method !== "function") throw new Error(`Surface does not support ${key}`);
    (method as (argument: Parameters<TiledSurface[K]>[0]) => void).call(surface, value);
  }
  return {
    body,
    scene,
    camera,
    renderer,
    context,
    surface,
    stats: stats as Readonly<GlobeStats>,
    ready: surface.ready ?? Promise.resolve(),
    requestRender,
    render,
    dispose,
    sampleHeight,
    addLayer: host.add,
    removeLayer(id: string) {
      if (id === options.environment?.id)
        throw new Error("The environment cannot be removed; dispose the globe instead");
      if (id === surface.id)
        throw new Error("The surface cannot be removed; dispose the globe instead");
      host.remove(id);
    },
    onFrame(listener: (stats: Readonly<GlobeStats>) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Orbit a moving target such as a spacecraft; null returns to orbiting the body. */
    setCameraFocus(focus: CameraFocus | null) {
      controls!.setFocus(focus);
      requestRender();
    },
    setExposure(stops: number) {
      if (!Number.isFinite(stops)) throw new RangeError("Invalid exposure");
      renderer.toneMappingExposure = 2 ** stops;
      requestRender();
    },
    setAltitude(altitude: number) {
      if (!Number.isFinite(altitude) || altitude < minAltitude)
        throw new RangeError("Invalid altitude");
      // Focus aim() replaces the camera each frame, so the follow distance has to move with it.
      if (controls!.focusDistance === undefined)
        camera.position.setLength(radius + groundHeight() + altitude);
      else controls!.setFocusDistance(altitude);
      requestRender();
    },
    goTo(latitudeDeg: number, longitudeDeg: number, altitude = 10000) {
      if (
        !Number.isFinite(latitudeDeg) ||
        Math.abs(latitudeDeg) > 90 ||
        !Number.isFinite(longitudeDeg) ||
        Math.abs(longitudeDeg) > 180 ||
        !Number.isFinite(altitude) ||
        altitude < minAltitude
      )
        throw new RangeError("Invalid location");
      camera.position.set(
        ...sunDirection((longitudeDeg * Math.PI) / 180, (latitudeDeg * Math.PI) / 180),
      );
      camera.position.multiplyScalar(radius + groundHeight() + altitude);
      controls!.reset();
      requestRender();
    },
    setSun(longitudeDeg: number, latitudeDeg: number) {
      if (![longitudeDeg, latitudeDeg].every(Number.isFinite) || Math.abs(latitudeDeg) > 90)
        throw new RangeError("Invalid sunlight direction");
      sun.longitudeDeg = longitudeDeg;
      sun.latitudeDeg = latitudeDeg;
      sun.direction.set(
        ...sunDirection((longitudeDeg * Math.PI) / 180, (latitudeDeg * Math.PI) / 180),
      );
      requestRender();
    },
    setSurfaceLayer: (mode: SurfaceLayer) => terrainControl("setSurfaceLayer", mode),
    setNormalCacheEnabled: (enabled: boolean) => terrainControl("setNormalCacheEnabled", enabled),
    setSunlightCacheEnabled: (enabled: boolean) =>
      terrainControl("setSunlightCacheEnabled", enabled),
    setHapke: (enabled: boolean) => terrainControl("setHapke", enabled),
    setTerrainShadows: (enabled: boolean) => terrainControl("setTerrainShadows", enabled),
    setShadowSteps: (steps: number) => terrainControl("setShadowSteps", steps),
    setShading: (enabled: boolean) => terrainControl("setShading", enabled),
    setWireframe: (enabled: boolean) => terrainControl("setWireframe", enabled),
    setElevationEnabled: (enabled: boolean) => terrainControl("setElevationEnabled", enabled),
  };
}
export type Globe = Awaited<ReturnType<typeof createGlobe>>;
