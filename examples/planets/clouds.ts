import { Fn, If, uniform, vec4, wgslFn, texture, texture3D, sampler } from "three/tsl";
import { Vector2, DataTexture, LinearFilter, type Texture, type Node } from "three/webgpu";
import { decodeCloudNoise, type CloudNoise } from "./cloud-noise.ts";
import densitySource from "./shaders/cloud-density.wgsl?raw";
import cloudSource from "./shaders/clouds.wgsl?raw";

export const CLOUD_STEPS = { low: 48, medium: 96, high: 160 } as const;
export const CLOUD_PIXEL_BUDGET = { low: 512 ** 2, medium: 768 ** 2, high: 1024 ** 2 } as const;
export type CloudQuality = keyof typeof CLOUD_STEPS;

/** Static weather density with no frame history or permanent animation loop. */
export function createClouds(radiusMeters: number) {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0)
    throw new RangeError("Invalid cloud radius");
  const enabled = uniform(1);
  const weatherReady = uniform(0);
  const noiseReady = uniform(0);
  const emptyShape = decodeCloudNoise(new Uint8Array([203]), 1);
  const emptyDetail = decodeCloudNoise(new Uint8Array([182]), 1);
  const shapeNode = texture3D(emptyShape);
  const detailNode = texture3D(emptyDetail);
  const pixelAngle = uniform(0.001);
  const emptyWeather = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  // Match the loaded weather map's filtering from the very first compilation:
  // Three omits sampler bindings for nearest-only placeholder textures.
  emptyWeather.minFilter = emptyWeather.magFilter = LinearFilter;
  emptyWeather.needsUpdate = true;
  const weatherNode = texture(emptyWeather);
  const coverage = uniform(0.48);
  const steps = uniform(CLOUD_STEPS.medium, "uint");
  let quality: CloudQuality = "medium";
  const layer = uniform(new Vector2(1.0, 1.2)); // kilometers above the reference sphere
  // The first WGSL function is the callable entry point; helpers follow it.
  const march = wgslFn(cloudSource + "\n" + densitySource);
  return {
    get pixelBudget() {
      return CLOUD_PIXEL_BUDGET[quality];
    },
    sample(
      origin: Node<"vec3">,
      direction: Node<"vec3">,
      sun: Node<"vec3">,
      maxDistance: Node<"float">,
      lighting: { direct: Node<"vec3">; indirect: Node<"vec3"> },
    ): Node<"vec4"> {
      return Fn(() => {
        const result = vec4(0).toVar();
        If(enabled.mul(weatherReady).mul(noiseReady).greaterThan(0.5), () => {
          result.assign(
            march({
              origin,
              direction,
              sun,
              radius: radiusMeters / 1000,
              layer,
              coverage,
              steps,
              maxDistance,
              weatherMap: weatherNode,
              weatherSampler: sampler(weatherNode),
              shapeMap: shapeNode,
              shapeSampler: sampler(shapeNode),
              detailMap: detailNode,
              detailSampler: sampler(detailNode),
              pixelAngle,
              sunLight: lighting.direct,
              skyLight: lighting.indirect,
            }) as Node<"vec4">,
          );
        });
        return result;
      })();
    },
    // Caller owns the loaded volumes, just as it owns the weather texture.
    setNoise(value: CloudNoise) {
      for (const volume of [value.shape, value.detail]) {
        // Keep the WGSL sampler layout stable even for caller-created volumes.
        volume.minFilter = volume.magFilter = LinearFilter;
        volume.needsUpdate = true;
      }
      shapeNode.value = value.shape;
      detailNode.value = value.detail;
      noiseReady.value = 1;
    },
    setPixelAngle(value: number) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError("Invalid cloud pixel angle");
      pixelAngle.value = value;
    },
    // Caller owns the supplied texture; this controller only owns its placeholder.
    setWeather(value: Texture) {
      value.minFilter = value.magFilter = LinearFilter;
      value.generateMipmaps = false;
      value.needsUpdate = true;
      weatherNode.value = value;
      weatherReady.value = 1;
    },
    dispose() {
      emptyWeather.dispose();
      emptyShape.dispose();
      emptyDetail.dispose();
    },
    setEnabled(value: boolean) {
      enabled.value = value ? 1 : 0;
    },
    setCoverage(value: number) {
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new RangeError("Cloud coverage must be between 0 and 1");
      coverage.value = value;
    },
    setQuality(value: CloudQuality) {
      if (!Object.hasOwn(CLOUD_STEPS, value)) throw new RangeError("Invalid cloud quality");
      steps.value = CLOUD_STEPS[value];
      quality = value;
    },
  };
}
