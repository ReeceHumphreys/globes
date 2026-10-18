import type { TerrainCacheStats } from "./rendering/terrain-compute.ts";
import type * as THREE from "three/webgpu";
import type { GlobeBody } from "./body.ts";

export interface GlobeStats {
  tiles: number;
  triangles: number;
  deepestLevel: number;
  selectionMs: number;
  altitudeMeters: number;
  imageryAvailable: boolean;
  elevationAvailable: boolean;
  imageryStatus: string;
  elevationStatus: string;
  terrainCaches?: Readonly<TerrainCacheStats>;
}
export type SurfaceLayer = "imagery" | "overview" | "terrain" | "checker";

/** Owned final rendering stage. The engine still schedules and prepares frames. */
export interface GlobeRenderPipeline {
  render(): void;
  dispose(): void;
}

/** Optional surface lighting, in body-fixed meters and linear RGB. */
export interface TerrainLightingInputs {
  color: THREE.Node<"vec3">;
  fallback: THREE.Node<"vec3">;
  normal: THREE.Node<"vec3">;
  position: THREE.Node<"vec3">;
  /** Surface-to-camera direction in the body frame. */
  view: THREE.Node<"vec3">;
  /** Zero for checkerboard and neutral-terrain inspection. */
  imageryEnabled: THREE.Node<"float">;
  sunlight: THREE.Node<"float">;
  enabled: THREE.Node<"float">;
}
export type TerrainLighting = (inputs: TerrainLightingInputs) => THREE.Node<"vec3">;

/** Body-fixed frame: +Y north, +X longitude zero, +Z longitude -90 degrees. Units are meters. */
export interface GlobeContext {
  readonly body: Readonly<GlobeBody>;
  /** Positioned host for viewport-aligned DOM layers. */
  readonly container: HTMLElement;
  readonly scene: THREE.Scene;
  /**
   * Drawn after the scene and any compositor, with a cleared depth buffer, so atmosphere
   * and clouds never cover it. For orbital overlays; occlude against the body yourself.
   * There is no tone mapping or color conversion: materials output display (sRGB) values.
   */
  readonly overlay: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGPURenderer;
  /** One shared lighting/compositing provider, attached before terrain and models. */
  readonly environment?: GlobeEnvironment;
  readonly sun: {
    readonly direction: Readonly<THREE.Vector3>;
    readonly longitudeDeg: number;
    readonly latitudeDeg: number;
  };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly pixelRatio: number;
  };
  /** Aborted when this component is removed or the globe is disposed. */
  readonly signal: AbortSignal;
  readonly requestRender: () => void;
  readonly reportError: (error: unknown) => void;
  readonly sampleHeight: (x: number, y: number, z: number) => number;
}
export interface GlobeFrame {
  readonly context: GlobeContext;
  /** Monotonic milliseconds, from performance.now(). */
  readonly now: number;
  readonly deltaSeconds: number;
  readonly elapsedSeconds: number;
}
/** One owned instance per globe. Allocate in attach; release everything in dispose. */
export interface GlobeLayer {
  readonly id: string;
  attach(context: GlobeContext): void | Promise<void>;
  /**
   * Optional: runs before the camera is placed each frame. Advance clocks here so a camera
   * focus target and every layer's update see the same time.
   */
  prepare?(now: number): void;
  update(frame: GlobeFrame): void;
  dispose(): void;
}

/** Per-globe environment. Third-party atmosphere types stay behind this contract. */
export interface GlobeEnvironment extends GlobeLayer {
  /** True when the environment owns the scene lights for standard/PBR models. */
  readonly lightsModels?: boolean;
  readonly lighting?: TerrainLighting;
  /** Optional owned compositor. The engine disposes it before disposing layers. */
  createRenderPipeline?(context: GlobeContext): GlobeRenderPipeline;
}
/** The engine knows no terrain implementation. A gas giant can supply its own surface. */
export interface GlobeSurface extends GlobeLayer {
  readonly stats?: Partial<GlobeStats>;
  readonly ready?: Promise<void>;
  sampleHeight?(x: number, y: number, z: number): number;
  /** Advance streamed geometry before the engine checks camera clearance. */
  prepare?(now: number): void;
}
