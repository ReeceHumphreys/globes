import {
  AtmosphereContext,
  AtmosphereLight,
  AtmosphereLightNode,
  AtmosphereLUTNode,
  getIndirectLuminance,
  getIndirectLuminanceToPoint,
  getSplitScalarIlluminance,
} from "@takram/three-atmosphere/webgpu";
import { Ellipsoid } from "@takram/three-geospatial";
import { inverseProjectionMatrix, inverseViewMatrix } from "@takram/three-geospatial/webgpu";
import { Fn, If, context, texture, screenUV, uniform, vec2, vec4, wgslFn } from "three/tsl";
import {
  AmbientLight,
  DirectionalLight,
  LinearSRGBColorSpace,
  NoToneMapping,
  RenderTarget,
  Vector2,
  Group,
  HalfFloatType,
  DepthTexture,
  FloatType,
  Matrix4,
  RenderPipeline,
  type EventDispatcher,
  type Node,
  type Texture,
} from "three/webgpu";
import type { GlobeContext, GlobeRenderPipeline, GlobeEnvironment, GlobeFrame } from "tiled-globe";

import type { CloudNoise } from "./cloud-noise.ts";
import { createClouds, type CloudQuality } from "./clouds.ts";
import { CloudFrameCache, cloudFrameSize } from "./cloud-frame.ts";
import { createAtmosphericSurface } from "./surface-lighting.ts";
import depthSource from "./shaders/reconstruct-view-position.wgsl?raw";

import {
  atmosphereParameters,
  type AtmosphereBody,
  type AtmospherePresetOptions,
} from "./atmosphere-presets.ts";

/** Body frame (+Y north, -Z east) -> ECEF (+Z north, +Y east). Rotation only. */
export function bodyToECEF(): Matrix4 {
  return new Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
}

/** Experimental dependency adapter. Owns the LUTs and compositor, never the terrain. */
export function createPlanetAtmosphere(
  body: AtmosphereBody,
  radiusMeters: number,
  options: AtmospherePresetOptions = {},
) {
  const parameters = atmosphereParameters(body, radiusMeters, options);
  const lut = new AtmosphereLUTNode(parameters, HalfFloatType);
  const atmosphere = new AtmosphereContext(parameters, lut);
  atmosphere.ellipsoid = new Ellipsoid(radiusMeters, radiusMeters, radiusMeters);
  atmosphere.correctAltitude = false;
  atmosphere.constrainCamera = true;
  atmosphere.showGround = false;
  atmosphere.matrixWorldToECEF.value.copy(bodyToECEF());
  const enabled = uniform(1);
  const ready = uniform(0);
  const surface = createAtmosphericSurface(atmosphere, enabled.mul(ready), body);
  const clouds = body === "earth" ? createClouds(radiusMeters) : undefined;
  let host: GlobeContext | undefined;
  let previousContext: GlobeContext["renderer"]["contextNode"] | undefined;
  const modelLights = new Group();
  modelLights.name = "Shared atmospheric model lighting";
  const modelSun = new AtmosphereLight();
  const fallbackSun = new DirectionalLight(0xffffff, 3);
  const fallbackAmbient = new AmbientLight(0xffffff, 0.08);
  modelLights.add(modelSun, modelSun.target, fallbackSun, fallbackSun.target, fallbackAmbient);
  function syncLighting(next: GlobeContext) {
    atmosphere.sunDirectionECEF.value
      .copy(next.sun.direction)
      .transformDirection(atmosphere.matrixWorldToECEF.value);
    modelSun.visible = enabled.value > 0 && ready.value > 0;
    fallbackSun.visible = fallbackAmbient.visible = !modelSun.visible;
    fallbackSun.position.copy(next.sun.direction).multiplyScalar(radiusMeters * 2);
  }
  function attach(next: GlobeContext) {
    host = next;
    atmosphere.camera = next.camera;
    previousContext = next.renderer.contextNode;
    next.renderer.contextNode = context({
      ...(previousContext.value as object),
      getAtmosphere: () => atmosphere,
    });
    // Keep the compatibility cast at the third-party boundary (setup's return type).
    next.renderer.library.addLight(
      AtmosphereLightNode as unknown as Parameters<typeof next.renderer.library.addLight>[0],
      AtmosphereLight,
    );
    syncLighting(next);
    next.scene.add(modelLights);
  }
  let disposed = false;
  const events = lut as unknown as EventDispatcher<{ update: {} }>;
  let cloudRevision = 0;
  const request = () => {
    // Includes asynchronous LUT completion, asset replacement and UI changes.
    cloudRevision++;
    if (!disposed) host?.requestRender();
  };
  let lutVersion = -1;
  let completedStages = 0;
  const updateLUT = () => {
    if (lutVersion !== lut.version) {
      lutVersion = lut.version;
      completedStages = 0;
      ready.value = 0;
    }
    completedStages++;
    ready.value = completedStages >= 4 ? 1 : 0;
    request();
  };
  events.addEventListener("update", updateLUT);

  let releasePipeline: (() => void) | undefined;
  let surfaceHaze = true;
  let configureHaze: (() => void) | undefined;
  function dispose() {
    if (disposed) return;
    disposed = true;
    events.removeEventListener("update", updateLUT);
    releasePipeline?.();
    atmosphere.dispose();
    clouds?.dispose();
    surface.dispose();
    modelLights.removeFromParent();
    modelSun.dispose();
    fallbackSun.dispose();
    fallbackAmbient.dispose();
    if (host && previousContext) host.renderer.contextNode = previousContext;
  }

  function createPipeline(next: GlobeContext): GlobeRenderPipeline {
    if (!host || disposed) throw new Error("Attach the environment before creating its compositor");
    // Capture the scene explicitly before drawing the atmosphere. The color has
    // to belong to a completed scene draw, not a pass scheduled among the LUTs.
    const target = new RenderTarget(1, 1, {
      type: HalfFloatType,
      samples: 0,
    });
    target.texture.name = "Atmosphere scene color";
    target.depthTexture = new DepthTexture(1, 1, FloatType);
    target.depthTexture.name = "Atmosphere scene depth";
    const size = new Vector2();
    const color = texture(target.texture);
    const depth = texture(target.depthTexture, screenUV).r;
    const hasSurface = next.renderer.reversedDepthBuffer ? depth.greaterThan(0) : depth.lessThan(1);
    const reconstruct = wgslFn(depthSource);
    const surfaceOffset = Fn(() => {
      const projection = inverseProjectionMatrix(next.camera) as unknown as Node<"mat4">;
      const inverseView = inverseViewMatrix(next.camera) as unknown as Node<"mat4">;
      const view = reconstruct({
        uv: screenUV,
        depth,
        inverseProjection: projection,
      }) as Node<"vec3">;
      const offset = inverseView.mul(vec4(view, 0)).xyz;
      return atmosphere.matrixWorldToECEF.mul(vec4(offset, 0)).xyz.mul(parameters.worldToUnit);
    });
    const hazeEnabled = uniform(surfaceHaze ? 1 : 0);
    const radiusUnit = radiusMeters * parameters.worldToUnit;
    const cloudTarget = clouds
      ? new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })
      : undefined;
    if (cloudTarget) cloudTarget.texture.name = "Half-resolution cloud radiance and opacity";
    const cloudFrame = new CloudFrameCache();
    const viewRay = Fn(() => {
      const clip = vec4(
        screenUV.x.mul(2).sub(1),
        screenUV.y.mul(-2).add(1),
        next.renderer.reversedDepthBuffer ? 1 : 0,
        1,
      );
      const projection = inverseProjectionMatrix(next.camera) as unknown as Node<"mat4">;
      const inverseView = inverseViewMatrix(next.camera) as unknown as Node<"mat4">;
      const rayWorld = inverseView.mul(vec4(projection.mul(clip).xyz, 0)).xyz;
      return atmosphere.matrixWorldToECEF.mul(vec4(rayWorld, 0)).xyz.normalize();
    });
    const cloudPipeline = clouds
      ? new RenderPipeline(
          next.renderer,
          Fn(() => {
            atmosphere.parametersNode.toStack();
            const result = vec4(0).toVar();
            If(ready.greaterThan(0.5), () => {
              const direction = viewRay();
              const camera = atmosphere.cameraPositionUnit;
              const approach = camera.dot(direction);
              const discriminant = approach
                .pow2()
                .sub(camera.dot(camera).sub(radiusUnit * radiusUnit));
              const root = discriminant.max(0).sqrt();
              const near = approach.negate().sub(root);
              const far = approach.negate().add(root);
              const distance = near.greaterThan(0).select(near, far);
              const hit = discriminant.greaterThanEqual(0).and(distance.greaterThan(0));
              // Like upstream's min/max layer illumination, evaluate atmospheric
              // Sun and sky once per ray rather than at every density sample.
              const referenceDistance = hit.select(distance, approach.negate().max(0));
              const reference = camera
                .add(direction.mul(referenceDistance))
                .normalize()
                .mul(radiusUnit + 1.6);
              const light = getSplitScalarIlluminance(reference, atmosphere.sunDirectionECEF);
              result.assign(
                clouds.sample(
                  camera,
                  direction,
                  atmosphere.sunDirectionECEF,
                  hit.select(distance, 1e8),
                  {
                    direct: light.get("direct") as Node<"vec3">,
                    indirect: light.get("indirect") as Node<"vec3">,
                  },
                ),
              );
            });
            return result;
          })(),
        )
      : undefined;
    if (cloudPipeline) cloudPipeline.outputColorTransform = false;
    const aerial = Fn(() => {
      atmosphere.parametersNode.toStack();
      const sceneColor = color.sample(screenUV);
      const direction = viewRay();
      const camera = atmosphere.cameraPositionUnit;
      const approach = camera.dot(direction);
      const hitsBody = approach
        .pow2()
        .sub(camera.dot(camera).sub(radiusUnit * radiusUnit))
        .greaterThanEqual(0);
      const result = sceneColor.rgb.toVar();
      If(ready.greaterThan(0.5), () => {
        If(hasSurface, () => {
          If(hazeEnabled.greaterThan(0.5), () => {
            const transport = getIndirectLuminanceToPoint(
              camera,
              camera.add(surfaceOffset()),
              vec2(0),
              atmosphere.sunDirectionECEF,
            );
            result.assign(
              sceneColor.rgb.mul(transport.get("transmittance")).add(transport.get("luminance")),
            );
          });
        }).Else(() => {
          const transport = getIndirectLuminance(
            camera,
            direction,
            vec2(0),
            atmosphere.sunDirectionECEF,
          );
          const scattered = transport.get("luminance") as Node<"vec3">;
          // Takram zeroes this transmittance on a ground hit before showGround applies.
          const attenuated = sceneColor.rgb.mul(transport.get("transmittance")).add(scattered);
          result.assign(hitsBody.select(sceneColor.rgb.add(scattered), attenuated));
        });
      });
      const output = vec4(result, sceneColor.a);
      if (!cloudTarget) return output;
      const volume = texture(cloudTarget.texture, screenUV);
      return vec4(output.rgb.mul(volume.a.oneMinus()).add(volume.rgb), output.a);
    })();
    const pipeline = new RenderPipeline(next.renderer, aerial);
    configureHaze = () => {
      hazeEnabled.value = surfaceHaze ? 1 : 0;
    };
    configureHaze();
    releasePipeline = () => {
      pipeline.dispose();
      target.dispose();
      cloudPipeline?.dispose();
      cloudTarget?.dispose();
      releasePipeline = undefined;
      configureHaze = undefined;
    };
    return {
      render() {
        if (lutVersion !== lut.version) ready.value = 0;
        syncLighting(next);
        if (enabled.value <= 0) {
          next.renderer.render(next.scene, next.camera);
          return;
        }
        const renderer = next.renderer;
        renderer.getDrawingBufferSize(size);
        target.setSize(size.x, size.y);
        const previousTarget = renderer.getRenderTarget();
        const previousToneMapping = renderer.toneMapping;
        const previousColorSpace = renderer.outputColorSpace;
        const previousMRT = renderer.getMRT();
        try {
          renderer.setRenderTarget(target);
          renderer.setMRT(null);
          // The final compositor alone applies exposure, tone mapping and sRGB.
          renderer.toneMapping = NoToneMapping;
          renderer.outputColorSpace = LinearSRGBColorSpace;
          renderer.render(next.scene, next.camera);
          if (cloudTarget && cloudPipeline) {
            const [width, height] = cloudFrameSize(size.x, size.y, clouds!.pixelBudget);
            const sun = atmosphere.sunDirectionECEF.value;
            const body = atmosphere.matrixWorldToECEF.value;
            if (!cloudFrame.matches(next.camera, sun, body, cloudRevision, width, height)) {
              cloudTarget.setSize(width, height);
              clouds!.setPixelAngle((2 * Math.tan((next.camera.fov * Math.PI) / 360)) / height);
              renderer.setRenderTarget(cloudTarget);
              cloudPipeline.render();
              // Commit only after a successful draw; failures must be retryable.
              cloudFrame.commit(next.camera, sun, body, cloudRevision, width, height);
            }
          }
        } finally {
          renderer.setRenderTarget(previousTarget);
          renderer.setMRT(previousMRT);
          renderer.toneMapping = previousToneMapping;
          renderer.outputColorSpace = previousColorSpace;
        }
        pipeline.render();
      },
      dispose() {
        releasePipeline?.();
      },
    };
  }
  return {
    id: "atmosphere-environment",
    lighting: surface.lighting,
    lightsModels: true,
    attach,
    update({ context }: GlobeFrame) {
      syncLighting(context);
    },
    createRenderPipeline: createPipeline,
    dispose,
    setOceanMask(value: Texture) {
      surface.setMask(value);
      request();
    },
    setOceansEnabled(value: boolean) {
      surface.setEnabled(value);
      request();
    },
    setOceanRoughness(value: number) {
      surface.setRoughness(value);
      request();
    },
    setCloudNoise(value: CloudNoise) {
      clouds?.setNoise(value);
      request();
    },
    setCloudWeather(value: Texture) {
      clouds?.setWeather(value);
      request();
    },
    setCloudsEnabled(value: boolean) {
      clouds?.setEnabled(value);
      request();
    },
    setCloudCoverage(value: number) {
      clouds?.setCoverage(value);
      request();
    },
    setCloudQuality(value: CloudQuality) {
      clouds?.setQuality(value);
      request();
    },
    setSurfaceHaze(value: boolean) {
      surfaceHaze = value;
      configureHaze?.();
      request();
    },
    setEnabled(value: boolean) {
      enabled.value = value ? 1 : 0;
      if (host) syncLighting(host);
      request();
    },
  } satisfies GlobeEnvironment & {
    setEnabled(value: boolean): void;
    setCloudNoise(value: CloudNoise): void;
    setCloudWeather(value: Texture): void;
    setCloudsEnabled(value: boolean): void;
    setCloudCoverage(value: number): void;
    setCloudQuality(value: CloudQuality): void;
    setSurfaceHaze(value: boolean): void;
    setOceanMask(value: Texture): void;
    setOceansEnabled(value: boolean): void;
    setOceanRoughness(value: number): void;
  };
}

export { atmosphereParameters } from "./atmosphere-presets.ts";
