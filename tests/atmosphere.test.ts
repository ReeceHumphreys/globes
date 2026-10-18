import assert from "node:assert/strict";
import test from "node:test";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import * as THREE from "three/src/Three.WebGPU.js";
import WGSLNodeBuilder from "three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js";
import { takramCompatibility } from "../examples/planets/takram-compat-plugin.ts";

const bundle = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [takramCompatibility()],
  ssr: { noExternal: [/@takram/] },
  build: {
    ssr: fileURLToPath(new URL("../examples/planets/atmosphere.ts", import.meta.url)),
    write: false,
    minify: false,
  },
});
const code = bundle.output
  .find((c) => c.type === "chunk" && c.isEntry)!
  .code.replace(/from (["'])(three(?:\/[^"']*)?)\1/g, (_, quote, specifier) => {
    const path =
      specifier === "three/webgpu"
        ? "three/src/Three.WebGPU.js"
        : specifier === "three/tsl"
          ? "three/src/nodes/TSL.js"
          : specifier === "three"
            ? "three/src/Three.js"
            : specifier;
    return `from ${JSON.stringify(import.meta.resolve(path))}`;
  });
const { createPlanetAtmosphere, atmosphereParameters, bodyToECEF } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

test("Earth atmosphere maps north and east into ECEF without changing handedness", () => {
  const matrix = bodyToECEF();
  assert.deepEqual(new THREE.Vector3(1, 0, 0).applyMatrix4(matrix).toArray(), [1, 0, 0]);
  assert.deepEqual(new THREE.Vector3(0, 1, 0).applyMatrix4(matrix).toArray(), [0, 0, 1]);
  assert.deepEqual(new THREE.Vector3(0, 0, -1).applyMatrix4(matrix).toArray(), [0, 1, 0]);
  assert.equal(matrix.determinant(), 1);
});

for (const [bodyId, radius, thickness] of [
  ["earth", 6378137, 60000],
  ["mars", 3396190, 80000],
] as const)
  test(`${bodyId} atmosphere builds compositor and four compute stages on Three r186`, async (t) => {
    const OriginalRequest = Request;
    t.mock.method(
      globalThis,
      "Request",
      class extends OriginalRequest {
        constructor(input: string | Request, init?: RequestInit) {
          super(
            typeof input === "string" ? new URL(input, "https://example.test/").href : input,
            init,
          );
        }
      },
    );
    t.mock.method(globalThis, "fetch", async (request: Request) => {
      assert.ok(request.url.startsWith("https://example.test/assets/stbn-"));
      return new Response(new Uint8Array(128 * 128 * 64));
    });
    const previousProgress = Object.getOwnPropertyDescriptor(globalThis, "ProgressEvent");
    Object.defineProperty(globalThis, "ProgressEvent", {
      configurable: true,
      value: class extends Event {
        constructor(type: string, values: object) {
          super(type);
          Object.assign(this, values);
        }
      },
    });
    t.after(() => {
      if (previousProgress) Object.defineProperty(globalThis, "ProgressEvent", previousProgress);
      else Reflect.deleteProperty(globalThis, "ProgressEvent");
    });
    const renderer = new THREE.WebGPURenderer({
      canvas: { width: 800, height: 600, style: {} } as HTMLCanvasElement,
      reversedDepthBuffer: true,
    });
    renderer.hasFeature = () => false;
    renderer.backend.hasFeature = () => false;
    renderer.backend.utils.getTextureSampleData = () => ({ primarySamples: 1 });
    renderer.backend.capabilities.getUniformBufferLimit = () => 65536;
    renderer.getDrawingBufferSize = (target) => target.set(800, 600);
    const camera = new THREE.PerspectiveCamera(75, 4 / 3, 10, 3e7);
    camera.position.set(radius * 3, 0, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const scene = new THREE.Scene();
    const previousContext = renderer.contextNode;
    let requests = 0,
      directDraws = 0,
      quad,
      quadVertex;
    const draws: { object: unknown; target: unknown; toneMapping: number; colorSpace: string }[] =
      [];
    renderer.render = (object) => {
      quad = object;
      if (object.isQuadMesh) quadVertex = object.material.vertexNode;
      directDraws++;
      draws.push({
        object,
        target: renderer.getRenderTarget(),
        toneMapping: renderer.toneMapping,
        colorSpace: renderer.outputColorSpace,
      });
    };
    const adapter = createPlanetAtmosphere(bodyId, radius);
    const context = {
      renderer,
      camera,
      scene,
      sun: { direction: new THREE.Vector3(0, 1, 0) },
      requestRender() {
        requests++;
      },
    };
    adapter.attach(context);
    const pipeline = adapter.createRenderPipeline(context);
    assert.equal(scene.children.filter((child) => child.isGroup).length, 1);
    assert.equal(adapter.lightsModels, true);
    const originalToneMapping = renderer.toneMapping;
    const originalColorSpace = renderer.outputColorSpace;
    pipeline.render();
    assert.equal(draws.length, bodyId === "earth" ? 3 : 2);
    assert.equal(draws[0].object, scene);
    const capture = draws[0].target as THREE.RenderTarget;
    assert.ok(capture.isRenderTarget);
    assert.equal(capture.width, 800);
    assert.equal(capture.height, 600);
    assert.ok(capture.depthTexture?.isDepthTexture);
    assert.equal(capture.depthTexture.type, THREE.FloatType);
    assert.equal(draws[0].toneMapping, THREE.NoToneMapping);
    assert.equal(draws[0].colorSpace, THREE.LinearSRGBColorSpace);
    assert.notEqual(draws[1].object, scene);
    assert.equal(draws.at(-1)!.target, null);
    if (bodyId === "earth") {
      const cloudCapture = draws[1].target as THREE.RenderTarget;
      assert.equal(cloudCapture.width, 400);
      assert.equal(cloudCapture.height, 300);
      assert.equal(cloudCapture.depthBuffer, false);
      const cloudQuad = draws[1].object as THREE.Mesh;
      cloudQuad.material.vertexNode = quadVertex;
      const cloudBuilder = new WGSLNodeBuilder(cloudQuad, renderer);
      cloudBuilder.scene = scene;
      cloudBuilder.camera = camera;
      Object.assign(cloudBuilder.context, renderer.contextNode.value);
      cloudBuilder.build();
      assert.match(cloudBuilder.fragmentShader, /fn marchClouds/);
      assert.match(cloudBuilder.fragmentShader, /fn cloudSun/);
      assert.match(cloudBuilder.fragmentShader, /fn cloudDensityFromSamples/);
      assert.match(cloudBuilder.fragmentShader, /texture_3d<f32>/);
      // The unloaded placeholder must declare the sampler required by WGSL,
      // keeping the binding layout stable when the real weather map arrives.
      assert.match(cloudBuilder.fragmentShader, /var nodeUniform\d+_sampler : sampler;/);
      assert.doesNotMatch(cloudBuilder.fragmentShader, /sRGBTransferOETF/);
      assert.doesNotMatch(cloudBuilder.vertexShader, /@location\(/);
      assert.throws(() => adapter.setCloudCoverage(-0.1), /coverage/);
      assert.throws(() => adapter.setCloudCoverage(NaN), /coverage/);
      assert.throws(() => adapter.setCloudQuality("ultra"), /quality/);
    }
    assert.equal(renderer.toneMapping, originalToneMapping);
    assert.equal(renderer.outputColorSpace, originalColorSpace);
    const atmosphere = renderer.contextNode.value.getAtmosphere();
    assert.equal(atmosphere.parameters.bottomRadius, radius);
    assert.equal(atmosphere.parameters.topRadius, radius + thickness);
    assert.deepEqual(atmosphere.sunDirectionECEF.value.toArray(), [0, 0, 1]);
    // QuadMesh installs its fullscreen vertex node only during render(). Build
    // the shader that actually runs, rather than the material after restoration.
    quad.material.vertexNode = quadVertex;
    const builder = new WGSLNodeBuilder(quad, renderer);
    builder.scene = scene;
    builder.camera = camera;
    Object.assign(builder.context, renderer.contextNode.value);
    builder.build();
    assert.match(builder.fragmentShader, /struct AtmosphereParameters/);
    assert.match(builder.fragmentShader, /texture_depth/);
    assert.match(builder.fragmentShader, /fn reconstructViewPosition/);
    assert.match(builder.fragmentShader, /^\tlet atmosphereParameters =/m);
    assert.match(builder.vertexShader, /@builtin\( vertex_index \)/);
    assert.doesNotMatch(builder.vertexShader, /@location\(/);
    assert.match(builder.fragmentShader, /@builtin\( position \)/);
    // Surface lighting is built even while the LUT readiness uniform is zero.
    const tsl = await import("three/src/nodes/TSL.js");
    const surfaceMaterial = new THREE.MeshBasicNodeMaterial();
    surfaceMaterial.colorNode = adapter.lighting({
      color: tsl.vec3(0.35),
      fallback: tsl.vec3(0.35),
      normal: tsl.vec3(1, 0, 0),
      position: tsl.vec3(radius, 0, 0),
      view: tsl.vec3(1, 0, 0),
      sunlight: tsl.float(1),
      enabled: tsl.float(1),
      imageryEnabled: tsl.float(1),
    });
    const surfaceMesh = new THREE.Mesh(new THREE.PlaneGeometry(), surfaceMaterial);
    const surfaceBuilder = new WGSLNodeBuilder(surfaceMesh, renderer);
    surfaceBuilder.scene = scene;
    surfaceBuilder.camera = camera;
    Object.assign(surfaceBuilder.context, renderer.contextNode.value);
    surfaceBuilder.build();
    assert.match(surfaceBuilder.fragmentShader, /AtmosphereParameters/);
    // Shared camera conversions can reference this outside the lighting branch.
    assert.match(surfaceBuilder.fragmentShader, /^\tlet atmosphereParameters =/m);
    if (bodyId === "earth") assert.match(surfaceBuilder.fragmentShader, /fn oceanRadiance/);
    else assert.doesNotMatch(surfaceBuilder.fragmentShader, /fn oceanRadiance/);
    surfaceMesh.geometry.dispose();
    surfaceMaterial.dispose();
    let stages = 0;
    renderer.compute = (job) => {
      const compute = new WGSLNodeBuilder(null, renderer);
      compute.compute = job;
      compute.build();
      assert.match(compute.computeShader, /@compute/);
      stages++;
    };
    await atmosphere.lutNode.updateTextures(renderer);
    adapter.update({ context });
    assert.equal(stages, 4);
    assert.equal(requests, 4);
    // Standard model materials consume the same atmosphere through scene lights.
    const model = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
    const modelBuilder = new WGSLNodeBuilder(model, renderer);
    modelBuilder.scene = scene;
    modelBuilder.camera = camera;
    Object.assign(modelBuilder.context, renderer.contextNode.value);
    const activeLights = [];
    scene.traverseVisible((object) => {
      if (object.isLight) activeLights.push(object);
    });
    assert.equal(activeLights.length, 1);
    modelBuilder.lightsNode = new THREE.LightsNode().setLights(activeLights);
    modelBuilder.build();
    assert.match(modelBuilder.fragmentShader, /AtmosphereParameters/);
    model.geometry.dispose();
    model.material.dispose();
    // The viewer owns weather textures. Swapping a loaded map must request a
    // draw, while disposing the environment must leave the caller's map alive.
    let weatherDisposed = false;
    let noiseDisposed = 0;
    const noise = {
      shape: new THREE.Data3DTexture(new Uint8Array([203]), 1, 1, 1),
      detail: new THREE.Data3DTexture(new Uint8Array([182]), 1, 1, 1),
    };
    noise.shape.addEventListener("dispose", () => noiseDisposed++);
    noise.detail.addEventListener("dispose", () => noiseDisposed++);
    const weather = new THREE.DataTexture(new Uint8Array([160, 160, 160, 255]), 1, 1);
    weather.addEventListener("dispose", () => {
      weatherDisposed = true;
    });
    if (bodyId === "earth") {
      adapter.setCloudWeather(weather);
      assert.equal(requests, 5);
      adapter.setCloudNoise(noise);
      assert.equal(requests, 6);
    }
    adapter.setSurfaceHaze(false);
    pipeline.render();
    assert.notEqual(quad, scene); // The sky/compositor remains active in the comparison mode.
    adapter.setSurfaceHaze(true);
    adapter.setEnabled(false);
    pipeline.render();
    assert.equal(directDraws, bodyId === "earth" ? 7 : 5);
    assert.equal(quad, scene); // Disabled mode bypasses the compositor.
    if (bodyId === "earth") {
      const cloudCapture = draws[1].target as THREE.RenderTarget;
      const cloudDraws = () => draws.filter((draw) => draw.target === cloudCapture).length;
      adapter.setEnabled(true);
      pipeline.render();
      let count = cloudDraws();
      pipeline.render(); // Terrain uploads redraw the scene without changing clouds.
      assert.equal(cloudDraws(), count);
      camera.position.x += 10;
      camera.updateMatrixWorld(true);
      pipeline.render();
      assert.equal(cloudDraws(), ++count);
      camera.fov += 1;
      camera.updateProjectionMatrix();
      pipeline.render();
      assert.equal(cloudDraws(), ++count);
      context.sun.direction.set(1, 0, 0);
      pipeline.render();
      assert.equal(cloudDraws(), ++count);
      // A Retina/4K canvas must not silently multiply the cloud workload.
      renderer.getDrawingBufferSize = (target) => target.set(3840, 2160);
      pipeline.render();
      assert.equal(cloudDraws(), ++count);
      assert.ok(cloudCapture.width * cloudCapture.height <= 768 ** 2);
      assert.ok(Math.abs(cloudCapture.width / cloudCapture.height - 3840 / 2160) < 0.01);
      adapter.setCloudQuality("low");
      pipeline.render();
      assert.equal(cloudDraws(), ++count);
      assert.ok(cloudCapture.width * cloudCapture.height <= 512 ** 2);
      adapter.setCloudsEnabled(false);
      pipeline.render(); // Replace the cached clouds with transparency once.
      assert.equal(cloudDraws(), ++count);
      pipeline.render();
      assert.equal(cloudDraws(), count);
      adapter.setCloudsEnabled(true);
      pipeline.render();
      assert.equal(cloudDraws(), ++count);
      adapter.setCloudCoverage(0.4);
      pipeline.render();
      assert.equal(cloudDraws(), ++count);
      adapter.setCloudWeather(weather);
      pipeline.render();
      assert.equal(cloudDraws(), ++count);
      let maskDisposed = false;
      const mask = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
      mask.addEventListener("dispose", () => {
        maskDisposed = true;
      });
      adapter.setOceanMask(mask);
      adapter.setOceansEnabled(false);
      adapter.setOceansEnabled(true);
      adapter.setOceanRoughness(0.4);
      assert.throws(() => adapter.setOceanRoughness(0), /roughness/);
      assert.throws(() => adapter.setOceanRoughness(NaN), /roughness/);
      assert.equal(mask.magFilter, THREE.LinearFilter);
      assert.equal(mask.flipY, false);
      t.after(() => {
        assert.equal(maskDisposed, false);
        mask.dispose();
      });
      await atmosphere.lutNode.updateTextures(renderer);
      pipeline.render();
      assert.equal(cloudDraws(), ++count); // New atmospheric lighting invalidates reuse.
    }
    pipeline.dispose();
    pipeline.dispose();
    assert.notEqual(renderer.contextNode, previousContext);
    adapter.dispose();
    assert.equal(renderer.contextNode, previousContext);
    assert.equal(scene.children.length, 0);
    assert.equal(weatherDisposed, false);
    weather.dispose();
    assert.equal(noiseDisposed, 0);
    noise.shape.dispose();
    noise.detail.dispose();
    const oldRequests = requests;
    adapter.setEnabled(true);
    assert.equal(requests, oldRequests);
  });

test("Mars dust has consistent extinction, absorption, optical depth and solar scaling", () => {
  const earth = atmosphereParameters("earth", 6378137);
  const mars = atmosphereParameters("mars", 3396190);
  assert.equal(mars.combinedScatteringTextures, false);
  assert.equal(earth.combinedScatteringTextures, true);
  const h = 11000;
  const integrated = h * -Math.expm1(-(mars.topRadius - mars.bottomRadius) / h);
  assert.ok(Math.abs(mars.mieExtinction.y * integrated - 0.2) < 1e-12);
  for (const channel of ["x", "y", "z"]) {
    assert.ok(mars.mieScattering[channel] > 0);
    assert.ok(mars.mieScattering[channel] < mars.mieExtinction[channel]);
    assert.ok(
      Math.abs(mars.solarIrradiance[channel] / earth.solarIrradiance[channel] - 586.2 / 1361) <
        1e-12,
    );
  }
  assert.equal(mars.absorptionExtinction.length(), 0);
  assert.ok(mars.rayleighScattering.length() < earth.rayleighScattering.length() * 0.03);
  assert.equal(mars.rayleighDensity.layers[1].expScale, -1 / h);
  assert.throws(() => atmosphereParameters("mars", 0), /Invalid atmosphere radius/);
  for (const opticalDepth of [0, 0.2, 0.5, 1.5]) {
    const preset = atmosphereParameters("mars", 3396190, { marsDustOpticalDepth: opticalDepth });
    assert.ok(Math.abs(preset.mieExtinction.y * integrated - opticalDepth) < 1e-12);
    assert.ok(preset.mieScattering.y <= preset.mieExtinction.y);
    assert.deepEqual(preset.solarIrradiance, mars.solarIrradiance);
  }
  for (const invalid of [-1, NaN, Infinity, 4]) {
    assert.throws(
      () => atmosphereParameters("mars", 3396190, { marsDustOpticalDepth: invalid }),
      /optical depth/,
    );
  }
});
