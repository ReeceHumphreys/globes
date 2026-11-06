import * as THREE from "three/webgpu";
import {
  Fn,
  cameraProjectionMatrixInverse,
  float,
  getViewPosition,
  instanceIndex,
  sampler,
  screenUV,
  select,
  texture,
  texture3D,
  textureStore,
  uniform,
  uvec3,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportSharedTexture,
  wgslFn,
} from "three/tsl";
import transmittanceShader from "../rendering/shaders/atmosphere-transmittance.wgsl?raw";
import skyShader from "../rendering/shaders/atmosphere-sky.wgsl?raw";
import viewShader from "../rendering/shaders/atmosphere-view.wgsl?raw";
import viewCoordsShader from "../rendering/shaders/atmosphere-view-coords.wgsl?raw";
import cloudCoverShader from "../rendering/shaders/cloud-cover.wgsl?raw";
import cloudLightShader from "../rendering/shaders/cloud-light.wgsl?raw";
import latLonToUVShader from "../rendering/shaders/lat-lon-to-uv.wgsl?raw";
import positionToLatLonShader from "../rendering/shaders/position-to-lat-lon.wgsl?raw";
import surfaceDetailShader from "../rendering/shaders/surface-detail.wgsl?raw";
import skyLightUShader from "../rendering/shaders/sky-light-u.wgsl?raw";
import { onePixel } from "../rendering/one-pixel.ts";
import {
  EARTH_AIR,
  MULTIPLE_SCATTERING_SIZE,
  SKY_LIGHT_WIDTH,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
  buildAtmosphere,
  type AtmosphereModel,
  type AtmospherePreset,
  type RGB,
} from "./model.ts";
import type { Clouds } from "./clouds.ts";

/**
 * This frame's light, resolved once for the sky and the terrain under it. The textures
 * stay owned by the Atmosphere, and the cloud map by its Clouds. @internal
 */
export interface AtmosphereLight {
  readonly transmittance: THREE.Texture;
  readonly skyLight: THREE.Texture;
  readonly bottom: number;
  readonly top: number;
  readonly intensity: number;
  readonly nightLight: RGB;
  cloudMap?: THREE.Texture;
  cloudAltitude: number;
  cloudStrength: number;
}

/** What the globe already knows about this frame. @internal */
export interface AtmosphereView {
  reversedDepth: boolean;
  /** Drawing buffer height in pixels. */
  bufferHeight: number;
}

/** The globe an atmosphere belongs to: its parent. */
interface AtmosphereParent extends THREE.Object3D {
  readonly radius: number;
  readonly flattening: number;
  sunDirection(out: THREE.Vector3): THREE.Vector3;
  altitudeOf(point: THREE.Vector3): number;
}

// Azimuth from the sun, ray angle in two bands, distance along the ray.
const VIEW_SIZE = [64, 128, 32] as const;

const _bodyFromView = new THREE.Matrix4(),
  _stretch = new THREE.Matrix4(),
  _camera = new THREE.Vector3();

/**
 * Air around a TiledGlobe: haze over the terrain and anything else drawn, the sky,
 * the glow at the planet's edge, and the colour of sunlight and skylight on the ground.
 *
 * Add it to the globe: `earth.add(new Atmosphere(EARTH_AIR))`. Nothing else is needed;
 * `globe.update()` keeps it current. Each frame a small compute pass tabulates the light
 * along every ray from the camera's height, and each pixel reads that table at its own
 * depth, so it composites exactly over terrain, models and stars. It draws after opaque
 * objects and before other transparent ones, and costs one copy of the frame plus a
 * table lookup for the pixels it covers.
 */
export class Atmosphere extends THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicNodeMaterial> {
  /** @internal */
  readonly isAtmosphere = true;
  override readonly type = "Atmosphere";
  /** The air this was built from. */
  readonly preset: AtmospherePreset;
  #model?: AtmosphereModel;
  #light?: AtmosphereLight;
  readonly #uniforms = {
    camera: uniform(new THREE.Vector3()),
    sun: uniform(new THREE.Vector3(0, 1, 0)),
    bottom: uniform(1),
    top: uniform(2),
    polarRatio: uniform(1),
    reversedDepth: uniform(0),
    stretchedFromView: uniform(new THREE.Matrix3()),
    tableRadius: uniform(2),
    tableSun: uniform(0),
    cloudRadius: uniform(1),
    cloudStrength: uniform(0),
    pixelAngle: uniform(0),
    cloudTexels: uniform(1),
  };
  readonly #lut = texture(onePixel(255));
  readonly #multiple = texture(onePixel(255));
  readonly #skyLight = texture(onePixel(255));
  readonly #clouds = texture(onePixel(255));
  readonly #gathered = viewTable("Atmosphere gathered light");
  readonly #passed = viewTable("Atmosphere transmittance");
  // Must match the source: a render pass with reversed depth uses 32-bit float.
  readonly #depthCopy = new THREE.DepthTexture(1, 1);
  readonly #tabulate: THREE.ComputeNode;
  #tabulated = "";

  constructor(preset: AtmospherePreset = EARTH_AIR) {
    super(new THREE.SphereGeometry(1, 96, 48));
    this.preset = preset;
    this.name = "Atmosphere";
    const u = this.#uniforms;
    const { rayleigh, mie, absorption, airglow, nightLight = [0, 0, 0] } = preset;
    const include = (source: string, ...needs: THREE.CodeNode[]) =>
      wgslFn(source, needs) as unknown as THREE.CodeNode;
    const transmittance = include(transmittanceShader);
    const coords = include(viewCoordsShader);
    const air = {
      rayleigh: vec4(...rayleigh.scattering, rayleigh.scaleHeight),
      mieScattering: vec4(...mie.scattering, mie.scaleHeight),
      mieExtinction: vec4(...mie.extinction, mie.g),
      absorption: vec4(...(absorption?.extinction ?? [0, 0, 0]), absorption?.center ?? 0),
      absorptionWidth: float(absorption?.width ?? 1),
    };
    const size = vec3(...VIEW_SIZE);
    const [width, height] = VIEW_SIZE;
    const view = wgslFn(viewShader, [transmittance, coords]);
    this.#tabulate = Fn(() => {
      const coord = uvec3(
        instanceIndex.mod(width),
        instanceIndex.div(width).mod(height),
        instanceIndex.div(width * height),
      );
      const ray = (
        view({
          coord,
          size,
          r: u.tableRadius,
          muSun: u.tableSun,
          bottom: u.bottom,
          top: u.top,
          lut: this.#lut,
          lutSampler: sampler(this.#lut),
          multiple: this.#multiple,
          multipleSampler: sampler(this.#multiple),
          ...air,
          intensity: float(preset.intensity),
          airglow: vec4(...(airglow?.emission ?? [0, 0, 0]), airglow?.altitude ?? 0),
          airglowWidth: float(airglow?.width ?? 1),
        }) as THREE.Node<"mat3">
      ).toVar() as unknown as { element(column: number): THREE.Node<"vec3"> };
      textureStore(this.#gathered, coord, vec4(ray.element(0), 1));
      textureStore(this.#passed, coord, vec4(ray.element(1), 1));
    })()
      .compute(VIEW_SIZE[0] * VIEW_SIZE[1] * VIEW_SIZE[2], [64])
      .setName("Atmosphere view tables");

    // three's typings omit the third argument, the texture to copy into.
    const depthOf = viewportDepthTexture as unknown as (
      uv: THREE.Node,
      level: null,
      depth: THREE.DepthTexture,
    ) => THREE.Node<"vec4">;
    const depth = depthOf(screenUV, null, this.#depthCopy).x;
    const empty = select(
      u.reversedDepth.greaterThan(0.5),
      select(depth.lessThanEqual(0), float(1), float(0)),
      select(depth.greaterThanEqual(1), float(1), float(0)),
    );
    const sky = wgslFn(skyShader, [
      transmittance,
      coords,
      include(
        cloudLightShader,
        include(cloudCoverShader, include(positionToLatLonShader), include(latLonToUVShader)),
        include(surfaceDetailShader),
      ),
      include(skyLightUShader),
    ]);
    const gathered = texture3D(this.#gathered);
    const color = sky({
      backdrop: viewportSharedTexture(screenUV).rgb,
      viewPosition: getViewPosition(screenUV, depth, cameraProjectionMatrixInverse),
      direction: getViewPosition(screenUV, float(0.5), cameraProjectionMatrixInverse),
      empty,
      stretchedFromView: u.stretchedFromView,
      o: u.camera,
      sun: u.sun,
      bottom: u.bottom,
      top: u.top,
      polarRatio: u.polarRatio,
      size,
      gathered,
      passed: texture3D(this.#passed),
      tableSampler: sampler(gathered),
      lut: this.#lut,
      lutSampler: sampler(this.#lut),
      skyLight: this.#skyLight,
      skySampler: sampler(this.#skyLight),
      intensity: float(preset.intensity),
      nightLight: vec3(...nightLight),
      cloudMap: this.#clouds,
      cloudSampler: sampler(this.#clouds),
      cloudRadius: u.cloudRadius,
      cloudStrength: u.cloudStrength,
      pixelAngle: u.pixelAngle,
      cloudTexels: u.cloudTexels,
    }) as THREE.Node<"vec3">;
    const material = new THREE.MeshBasicNodeMaterial({
      // Back faces only: from outside they cover the planet's footprint, from inside
      // they surround the camera, so crossing the top of the atmosphere needs no switch.
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // The shader composites over the copied frame itself, per colour channel.
      blending: THREE.NoBlending,
    });
    material.colorNode = color;
    this.material = material;
    // First among transparent objects, so it hazes opaque ones and overlays stay crisp.
    this.renderOrder = -1;
    this.frustumCulled = false;
    this.onBeforeRender = (renderer) => {
      const source = renderer.getRenderTarget()?.depthTexture;
      this.#depthCopy.type = source?.type ?? THREE.UnsignedIntType;
    };
  }

  // Tables for a globe of this radius, built on first use.
  #lightFor(radius: number): AtmosphereLight {
    if (this.#model?.bottom !== radius) {
      this.#light?.transmittance.dispose();
      this.#light?.skyLight.dispose();
      (this.#multiple.value as THREE.Texture).dispose();
      const model = (this.#model = buildAtmosphere(this.preset, radius));
      this.#light = {
        transmittance: halfFloatTexture(
          model.transmittance,
          TRANSMITTANCE_WIDTH,
          TRANSMITTANCE_HEIGHT,
        ),
        skyLight: halfFloatTexture(model.skyLight, SKY_LIGHT_WIDTH, 1),
        bottom: model.bottom,
        top: model.top,
        intensity: this.preset.intensity,
        nightLight: this.preset.nightLight ?? [0, 0, 0],
        cloudAltitude: 0,
        cloudStrength: 0,
      };
      this.#lut.value = this.#light.transmittance;
      this.#skyLight.value = this.#light.skyLight;
      this.#multiple.value = halfFloatTexture(
        model.multipleScattering,
        MULTIPLE_SCATTERING_SIZE,
        MULTIPLE_SCATTERING_SIZE,
      );
      this.#tabulated = "";
      this.scale.setScalar(model.top * 1.01);
    }
    return this.#light!;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.#light?.transmittance.dispose();
    this.#light?.skyLight.dispose();
    (this.#multiple.value as THREE.Texture).dispose();
    this.#gathered.dispose();
    this.#passed.dispose();
    this.removeFromParent();
  }

  /** Follow the camera and sun, and resolve this frame's light. The globe calls this. @internal */
  update(
    renderer: THREE.WebGPURenderer,
    camera: THREE.Camera,
    { reversedDepth, bufferHeight }: AtmosphereView,
  ): AtmosphereLight {
    const globe = this.parent as AtmosphereParent;
    const light = this.#lightFor(globe.radius);
    const u = this.#uniforms;
    u.bottom.value = light.bottom;
    u.top.value = light.top;
    u.reversedDepth.value = reversedDepth ? 1 : 0;
    // Rays run in the body frame, stretched along the poles until the ellipsoid is a
    // sphere: the air's shape then needs no special case. Formed in float64 here.
    const polarRatio = (u.polarRatio.value = 1 - globe.flattening);
    _stretch.makeScale(1, 1 / polarRatio, 1);
    _bodyFromView.copy(globe.matrixWorld).invert().multiply(camera.matrixWorld);
    u.stretchedFromView.value.setFromMatrix4(_bodyFromView.premultiply(_stretch));
    globe.worldToLocal(camera.getWorldPosition(_camera));
    const altitude = globe.altitudeOf(_camera);
    u.camera.value.copy(_camera).setY(_camera.y / polarRatio);
    globe.sunDirection(u.sun.value);
    this.#syncClouds(globe, light, camera, bufferHeight, altitude);

    // The tables depend only on the camera's height and the sun's angle to it.
    const r = Math.max(u.camera.value.length(), light.bottom + 1);
    const muSun = u.sun.value.dot(u.camera.value) / u.camera.value.length();
    const key = `${r.toFixed(0)} ${muSun.toFixed(4)}`;
    if (key !== this.#tabulated) {
      this.#tabulated = key;
      u.tableRadius.value = r;
      u.tableSun.value = muSun;
      renderer.compute(this.#tabulate);
    }
    return light;
  }

  #syncClouds(
    globe: AtmosphereParent,
    light: AtmosphereLight,
    camera: THREE.Camera,
    bufferHeight: number,
    altitude: number,
  ) {
    const u = this.#uniforms;
    const clouds = globe.children.find(
      (child): child is Clouds => (child as Partial<Clouds>).isClouds === true,
    );
    // Until its image loads, a layer has nothing to draw or to shade the ground with.
    light.cloudMap = clouds?.map;
    light.cloudAltitude = clouds?.altitude ?? 0;
    light.cloudStrength = clouds?.map ? clouds.strengthAt(altitude) : 0;
    u.cloudStrength.value = light.cloudStrength;
    if (!clouds?.map) return;
    this.#clouds.value = clouds.map;
    u.cloudRadius.value = globe.radius + clouds.altitude;
    u.pixelAngle.value = 2 / (camera.projectionMatrix.elements[5] * bufferHeight);
    u.cloudTexels.value =
      (2 * Math.PI * u.cloudRadius.value) / (clouds.map.image as ImageBitmap).width;
  }
}

function viewTable(name: string) {
  const table = new THREE.Storage3DTexture(...VIEW_SIZE);
  table.name = name;
  table.type = THREE.HalfFloatType;
  table.format = THREE.RGBAFormat;
  table.colorSpace = THREE.NoColorSpace;
  table.generateMipmaps = false;
  return table;
}

function halfFloatTexture(data: Float32Array, width: number, height: number) {
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const texture = new THREE.DataTexture(half, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
