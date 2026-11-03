import * as THREE from "three/webgpu";
import {
  cameraProjectionMatrixInverse,
  float,
  getViewPosition,
  sampler,
  screenUV,
  select,
  texture,
  uniform,
  vec4,
  viewportDepthTexture,
  viewportSharedTexture,
  wgslFn,
} from "three/tsl";
import transmittanceShader from "../rendering/shaders/atmosphere-transmittance.wgsl?raw";
import skyShader from "../rendering/shaders/atmosphere-sky.wgsl?raw";
import {
  EARTH_AIR,
  SKY_LIGHT_WIDTH,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
  buildAtmosphere,
  type AtmosphereModel,
  type AtmospherePreset,
} from "./model.ts";

/** What a TiledGlobe needs to light its terrain through this atmosphere. @internal */
export interface AtmosphereLight {
  readonly transmittance: THREE.Texture;
  readonly skyLight: THREE.Texture;
  readonly bottom: number;
  readonly top: number;
  readonly intensity: number;
}

/** The globe an atmosphere belongs to: its parent. */
interface AtmosphereParent extends THREE.Object3D {
  readonly radius: number;
  sunDirection(out: THREE.Vector3): THREE.Vector3;
}

const _sun = new THREE.Quaternion(),
  _inverseView = new THREE.Matrix4();

/**
 * Air around a TiledGlobe: haze over the terrain and anything else drawn, the sky,
 * the glow at the planet's edge, and the colour of sunlight and skylight on the ground.
 *
 * Add it to the globe: `earth.add(new Atmosphere(EARTH_AIR))`. Nothing else is needed.
 * Each frame it reads the depth and colour already drawn behind it and computes the
 * light the air adds and removes along every pixel's ray, so it composites exactly
 * over terrain, models and stars. It draws after opaque objects and before other
 * transparent ones, and costs one copy of the frame plus the pixels it covers.
 */
export class Atmosphere extends THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicNodeMaterial> {
  readonly isAtmosphere = true;
  override readonly type = "Atmosphere";
  readonly preset: AtmospherePreset;
  #model?: AtmosphereModel;
  #light?: AtmosphereLight;
  readonly #uniforms = {
    center: uniform(new THREE.Vector3()),
    sun: uniform(new THREE.Vector3(0, 1, 0)),
    bottom: uniform(1),
    top: uniform(2),
    reversedDepth: uniform(0),
  };
  readonly #lut = texture(placeholder());

  constructor(preset: AtmospherePreset = EARTH_AIR) {
    super(new THREE.SphereGeometry(1, 96, 48));
    this.preset = preset;
    this.name = "Atmosphere";
    const u = this.#uniforms;
    const { rayleigh, mie, absorption } = preset;
    const depth = viewportDepthTexture(screenUV).x;
    const empty = select(
      u.reversedDepth.greaterThan(0.5),
      select(depth.lessThanEqual(0), float(1), float(0)),
      select(depth.greaterThanEqual(1), float(1), float(0)),
    );
    const sky = wgslFn(skyShader, [wgslFn(transmittanceShader) as unknown as THREE.CodeNode]);
    const color = sky({
      backdrop: viewportSharedTexture(screenUV).rgb,
      viewPosition: getViewPosition(screenUV, depth, cameraProjectionMatrixInverse),
      direction: getViewPosition(screenUV, float(0.5), cameraProjectionMatrixInverse),
      empty,
      center: u.center,
      sun: u.sun,
      bottom: u.bottom,
      top: u.top,
      lut: this.#lut,
      lutSampler: sampler(this.#lut),
      rayleigh: vec4(...rayleigh.scattering, rayleigh.scaleHeight),
      mieScattering: vec4(...mie.scattering, mie.scaleHeight),
      mieExtinction: vec4(...mie.extinction, mie.g),
      absorption: vec4(...(absorption?.extinction ?? [0, 0, 0]), absorption?.center ?? 0),
      absorptionWidth: float(absorption?.width ?? 1),
      intensity: float(preset.intensity),
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
    // three's typings declare WebGLRenderer here; under WebGPU it is the WebGPURenderer.
    this.onBeforeRender = (renderer, _scene, camera) =>
      this.#sync(renderer as unknown as THREE.WebGPURenderer, camera);
  }

  /** Tables for a globe of this radius, built on first use. @internal */
  lightFor(radius: number): AtmosphereLight {
    if (this.#model?.bottom !== radius) {
      this.#light?.transmittance.dispose();
      this.#light?.skyLight.dispose();
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
      };
      this.#lut.value = this.#light.transmittance;
      this.scale.setScalar(model.top * 1.01);
    }
    return this.#light!;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.#light?.transmittance.dispose();
    this.#light?.skyLight.dispose();
    this.removeFromParent();
  }

  #sync(renderer: THREE.WebGPURenderer, camera: THREE.Camera) {
    const globe = this.parent as AtmosphereParent | null;
    if (!globe || !(globe.radius > 0)) return;
    const light = this.lightFor(globe.radius);
    const u = this.#uniforms;
    u.bottom.value = light.bottom;
    u.top.value = light.top;
    u.reversedDepth.value = renderer.reversedDepthBuffer ? 1 : 0;
    // Everything in view space, with the camera at the origin; positions are formed
    // in float64 here so the shader only sees camera-relative values.
    _inverseView.copy(camera.matrixWorldInverse);
    u.center.value.setFromMatrixPosition(globe.matrixWorld).applyMatrix4(_inverseView);
    globe
      .sunDirection(u.sun.value)
      .applyQuaternion(globe.getWorldQuaternion(_sun))
      .transformDirection(_inverseView);
  }
}

function placeholder() {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
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
