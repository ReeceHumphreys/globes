import * as THREE from "three/webgpu";
import { dFdx, dFdy, sampler, texture, uniform, wgslFn, length, vec2, mix } from "three/tsl";
import { graticuleLevels } from "./graticule-levels.ts";
import graticuleShader from "./rendering/shaders/graticule.wgsl?raw";
import imageOverlayShader from "./rendering/shaders/image-overlay.wgsl?raw";

/** Shader nodes describing the surface under a pixel, for overlays to read. */
export interface SurfacePoint {
  /** North-up equirectangular coordinates: u east, v south, both 0 to 1. */
  uv: THREE.Node<"vec2">;
  /** Screen derivatives of `uv`, safe across the antimeridian. Sample with `.grad(uvDx, uvDy)`. */
  uvDx: THREE.Node<"vec2">;
  uvDy: THREE.Node<"vec2">;
  /** Radians. Geodetic on a flattened globe. */
  latitude: THREE.Node<"float">;
  /** Radians, east positive. */
  longitude: THREE.Node<"float">;
  /** Surface normal in the globe's local frame. */
  normal: THREE.Node<"vec3">;
  /** Approximate size of the pixel on the ground. */
  pixelMeters: THREE.Node<"float">;
}

/** What an overlay learns about the camera each frame. @internal */
export interface OverlayView {
  altitude: number;
  radius: number;
  flattening: number;
  pixelRatio: number;
  /** In the globe's local frame. */
  camera: THREE.Vector3;
}

/**
 * Paints the surface of the TiledGlobe it is added to, following the terrain at every
 * zoom. `shader` returns a TSL vec4 of straight colour and alpha for each pixel.
 *
 * Overlays are unlit, so a map stays readable at night, and they lie under clouds and
 * haze. They stack in child order. Adding or removing one recompiles the terrain, so
 * add them once and toggle `visible` or `opacity`, which are free.
 */
export class SurfaceOverlay extends THREE.Object3D {
  readonly isSurfaceOverlay = true;
  override readonly type: string = "SurfaceOverlay";
  /** 0 to 1. */
  opacity: number;
  /** The opacity the shader sees. @internal */
  readonly strength = uniform(1);
  readonly #shader: (surface: SurfacePoint) => THREE.Node<"vec4">;

  constructor(
    shader: (surface: SurfacePoint) => THREE.Node<"vec4">,
    { opacity = 1 }: { opacity?: number } = {},
  ) {
    super();
    this.name = "Surface overlay";
    this.#shader = shader;
    this.opacity = opacity;
  }

  /** This overlay over what is already on the surface. @internal */
  over(color: THREE.Node<"vec3">, surface: SurfacePoint): THREE.Node<"vec3"> {
    const paint = this.#shader(surface);
    return mix(color, paint.rgb, paint.a.mul(this.strength)) as THREE.Node<"vec3">;
  }

  /** The globe calls this each frame. @internal */
  update(_view: OverlayView): void {
    this.strength.value = this.visible ? THREE.MathUtils.clamp(this.opacity, 0, 1) : 0;
  }

  dispose(): void {
    this.removeFromParent();
  }
}

export interface GraticuleOptions {
  /** Degrees between lines, dividing 360 evenly. Omit to follow the camera's altitude. */
  spacing?: number;
  color?: THREE.ColorRepresentation;
  opacity?: number;
  /** Line width in CSS pixels. */
  lineWidth?: number;
  /** Extra latitudes in degrees, up to four, such as the tropics. */
  parallels?: readonly number[];
}

const graticule = wgslFn(graticuleShader);
const NO_PARALLEL = 10; // radians: off the globe

/** Latitude and longitude lines, with a heavier equator and prime meridian. */
export class Graticule extends SurfaceOverlay {
  override readonly type = "Graticule";
  /** Line width in CSS pixels. */
  lineWidth: number;
  /** Degrees between lines, or undefined to follow the camera's altitude. */
  readonly spacing?: number;
  readonly #levels: { spacing: { value: THREE.Vector2 }; fineStrength: { value: number } };
  readonly #width: { value: number };

  constructor({
    spacing,
    color = "#fff",
    opacity = 0.5,
    lineWidth = 1,
    parallels = [],
  }: GraticuleOptions = {}) {
    if (spacing !== undefined) {
      const lines = 360 / spacing;
      if (!(spacing > 0) || Math.abs(lines - Math.round(lines)) > 1e-9)
        throw new RangeError("Graticule spacing must divide 360");
    }
    if (parallels.length > 4 || parallels.some((latitude) => !(Math.abs(latitude) <= 90)))
      throw new RangeError("Graticule takes up to four latitudes");
    const levels = {
      spacing: uniform(new THREE.Vector2(1, 1)),
      fineStrength: uniform(0),
    };
    const width = uniform(lineWidth);
    const tint = uniform(new THREE.Color(color));
    const named = [0, 1, 2, 3].map((i) =>
      i < parallels.length ? THREE.MathUtils.degToRad(parallels[i]) : NO_PARALLEL,
    );
    const namedParallels = uniform(new THREE.Vector4(...named));
    super(
      (surface) =>
        graticule({
          latitude: surface.latitude,
          longitude: surface.longitude,
          latitudeRate: length(vec2(dFdx(surface.latitude), dFdy(surface.latitude))),
          longitudeDx: dFdx(surface.longitude),
          longitudeDy: dFdy(surface.longitude),
          spacing: levels.spacing,
          fineStrength: levels.fineStrength,
          width,
          color: tint,
          parallels: namedParallels,
        }) as THREE.Node<"vec4">,
      { opacity },
    );
    this.name = "Graticule";
    this.lineWidth = lineWidth;
    this.spacing = spacing;
    this.#levels = levels;
    this.#width = width;
  }

  override update(view: OverlayView): void {
    super.update(view);
    this.#width.value = this.lineWidth * view.pixelRatio;
    // Roughly what the camera can see of the ground, up to most of a hemisphere.
    const across = THREE.MathUtils.radToDeg(Math.min(view.altitude / view.radius, 1.2));
    const [coarse, fine, strength] =
      this.spacing === undefined ? graticuleLevels(across) : [this.spacing, this.spacing, 0];
    this.#levels.spacing.value.set(
      THREE.MathUtils.degToRad(coarse),
      THREE.MathUtils.degToRad(fine),
    );
    this.#levels.fineStrength.value = strength;
  }
}

export interface ImageOverlayOptions {
  /**
   * North-up equirectangular image with alpha, covering the whole body: a URL, or a
   * Texture such as a CanvasTexture, whose ownership transfers. Set `needsUpdate` on a
   * Texture to redraw it.
   */
  map: string | THREE.Texture;
  opacity?: number;
}

const imageOverlay = wgslFn(imageOverlayShader);

/** An image draped over the whole body, such as a heatmap, coverage map or borders. */
export class ImageOverlay extends SurfaceOverlay {
  override readonly type: string = "ImageOverlay";
  /** The loaded image. Undefined until then. */
  map?: THREE.Texture;
  readonly #image: ReturnType<typeof texture>;
  readonly #empty: THREE.DataTexture;
  #disposed = false;

  constructor({ map, opacity = 1 }: ImageOverlayOptions) {
    const empty = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    // Nearest-filtered textures get no WGSL sampler, and the shader passes one.
    empty.minFilter = empty.magFilter = THREE.LinearFilter;
    empty.needsUpdate = true;
    const image = texture(empty);
    super(
      ({ uv, uvDx, uvDy }) =>
        imageOverlay({
          map: image,
          mapSampler: sampler(image),
          uv,
          uvDx,
          uvDy,
        }) as THREE.Node<"vec4">,
      { opacity },
    );
    this.name = "Image overlay";
    this.#image = image;
    this.#empty = empty;
    if (typeof map !== "string") this.#show(map);
    else
      new THREE.TextureLoader()
        .loadAsync(map)
        .then((loaded) => {
          if (this.#disposed) return loaded.dispose();
          loaded.colorSpace = THREE.SRGBColorSpace;
          this.#show(loaded);
        })
        // The globe is complete without its overlay.
        .catch((error: unknown) => console.warn("[ImageOverlay]", error));
  }

  #show(map: THREE.Texture) {
    map.flipY = false;
    map.wrapS = THREE.RepeatWrapping;
    map.needsUpdate = true;
    this.map = this.#image.value = map;
  }

  override dispose(): void {
    this.#disposed = true;
    this.map?.dispose();
    this.map = undefined;
    this.#empty.dispose();
    super.dispose();
  }
}
