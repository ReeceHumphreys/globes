import normalFromGradient from "../../src/rendering/shaders/normal-from-gradient.wgsl?raw";
// Bit flags from the WebGPU specification; TS DOM declares the interfaces but
// does not yet declare these runtime constant namespaces.
const GPUTextureUsage = { COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 };
const GPUBufferUsage = {
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  UNIFORM: 64,
  STORAGE: 128,
  QUERY_RESOLVE: 512,
};
const GPUMapMode = { READ: 1 };
import kernels from "./kernels.wgsl?raw";
import sampleLayer from "../../src/rendering/shaders/sample-height-layer.wgsl?raw";
import sampleSurface from "../../src/rendering/shaders/sample-surface-height.wgsl?raw";
import surfaceNormal from "../../src/rendering/shaders/surface-normal.wgsl?raw";
import solarVisibility from "../../src/rendering/shaders/solar-visibility.wgsl?raw";
import shadowHeight from "../../src/rendering/shaders/shadow-height.wgsl?raw";
import terrainSunlight from "../../src/rendering/shaders/terrain-sunlight.wgsl?raw";

interface Case {
  key: string;
  face: number;
  fineLayer: number;
  parentLayer: number;
  faceUV: number[];
  bestUV: number[];
  parentUV: number[];
}
interface Fixture {
  radius: number;
  width: number;
  layers: number;
  core: number;
  gutter: number;
  min: number;
  max: number;
  maxLevel: number;
  indexWidth: number;
  indexHeight: number;
  keys: string[];
  cases: Case[];
}
const slots = {
  buildGradients: [1, 5],
  directNormals: [1, 8, 9],
  cachedNormals: [3, 4, 8, 9],
  hybridNormals: [1, 3, 4, 8, 9],
  buildSunlight: [1, 2, 6, 8],
  directSunlight: [1, 2, 8, 9],
  cachedSunlight: [7, 8, 9],
} as const;
type Kernel = keyof typeof slots;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
async function fetchOK(path: string) {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error(
      `${path}: HTTP ${response.status}. Run npm run benchmark:terrain:prepare first.`,
    );
  return response;
}

/** Isolated compute-workload comparison, not viewer FPS. Uses production WGSL functions. */
export async function runTerrainCacheBenchmark(progress: (status: string) => void = () => {}) {
  if (!navigator.gpu) throw new Error("WebGPU is required");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter?.features.has("timestamp-query"))
    throw new Error("GPU timestamp queries are required for comparable timings");
  const device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
  try {
    const base = "/benchmarks/terrain-cache/";
    const fixture: Fixture = await (await fetchOK(base + "fixture.json")).json();
    const [heightBytes, indexBytes] = await Promise.all(
      ["heights.bin", "index.bin"].map(async (name) => (await fetchOK(base + name)).arrayBuffer()),
    );
    const heights = device.createTexture({
      size: [fixture.width, fixture.width, fixture.layers],
      format: "rg8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: heights },
      heightBytes,
      { bytesPerRow: fixture.width * 2, rowsPerImage: fixture.width },
      [fixture.width, fixture.width, fixture.layers],
    );
    const index = device.createTexture({
      size: [fixture.indexWidth, fixture.indexHeight],
      format: "rgba32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: index },
      indexBytes,
      { bytesPerRow: fixture.indexWidth * 16 },
      [fixture.indexWidth, fixture.indexHeight],
    );
    const gradients = device.createTexture({
      size: [fixture.width, fixture.width, fixture.layers],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const sunlight = device.createTexture({
      size: [33, 33, 1],
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const params = device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const buffers = new Map(
      [33, 97, 512].map((size) => [
        size,
        device.createBuffer({
          size: size * size * 16,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        }),
      ]),
    );
    const shaderCode = [
      sampleLayer,
      sampleSurface,
      normalFromGradient,
      surfaceNormal,
      solarVisibility,
      shadowHeight,
      terrainSunlight,
      kernels,
    ].join("\n");
    const module = device.createShaderModule({ code: shaderCode });
    const messages = await module.getCompilationInfo();
    const errors = messages.messages.filter((message) => message.type === "error");
    if (errors.length) throw new Error(errors.map((message) => message.message).join("\n"));
    const resources: Record<number, GPUBindingResource> = {
      1: heights.createView({ dimension: "2d-array" }),
      2: index.createView(),
      3: gradients.createView({ dimension: "2d-array" }),
      4: sampler,
      5: gradients.createView({ dimension: "2d-array" }),
      6: sunlight.createView({ dimension: "2d-array" }),
      7: sunlight.createView({ dimension: "2d-array" }),
      8: { buffer: params },
    };
    progress("Compiling compute pipelines…");
    const start = performance.now();
    const prepared = new Map<
      Kernel,
      { pipeline: GPUComputePipeline; groups: Map<number, GPUBindGroup> }
    >();
    for (const name of Object.keys(slots) as Kernel[]) {
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: name },
      });
      const groups = new Map<number, GPUBindGroup>();
      for (const [size, buffer] of buffers)
        groups.set(
          size,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: slots[name].map((binding) => ({
              binding,
              resource: binding === 9 ? { buffer } : resources[binding],
            })),
          }),
        );
      prepared.set(name, { pipeline, groups });
    }
    const pipelineSetupMs = performance.now() - start;
    const query = device.createQuerySet({ type: "timestamp", count: 2 });
    const queryBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    const staging = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    async function run(name: Kernel, size = 512, repeats = 256) {
      const { pipeline, groups } = prepared.get(name)!;
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass({
        timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, groups.get(size)!);
      for (let i = 0; i < repeats; i++) {
        if (name === "buildGradients")
          pass.dispatchWorkgroups(
            Math.ceil(fixture.width / 8),
            Math.ceil(fixture.width / 8),
            fixture.layers,
          );
        else if (name === "buildSunlight") pass.dispatchWorkgroups(5, 5);
        else pass.dispatchWorkgroups(Math.ceil((size * size) / 64));
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
      // Resolve after completion: also avoids delayed samples in the native
      // Metal validation backend used to cross-check this experiment.
      await device.queue.onSubmittedWorkDone();
      const resolve = device.createCommandEncoder();
      resolve.resolveQuerySet(query, 0, 2, queryBuffer, 0);
      resolve.copyBufferToBuffer(queryBuffer, 0, staging, 0, 16);
      device.queue.submit([resolve.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const values = new BigUint64Array(staging.getMappedRange());
      const elapsed = Number(values[1] - values[0]) / 1e6 / repeats;
      staging.unmap();
      return elapsed;
    }
    function setParams(c: Case, size = 512, fade = 1, angle = 1) {
      const u = c.faceUV[0] + c.faceUV[2] * 0.5,
        v = c.faceUV[1] + c.faceUV[3] * 0.5;
      // The prepared cases use +X and -Y faces. Keep benchmark geometry in the same frame.
      const p = c.face === 0 ? [1, 2 * v - 1, -(2 * u - 1)] : [2 * u - 1, -1, 2 * v - 1];
      const length = Math.hypot(...p);
      for (let i = 0; i < 3; i++) p[i] /= length;
      const axis = Math.abs(p[1]) < 0.8 ? [0, 1, 0] : [1, 0, 0];
      const tangent = [
        p[1] * axis[2] - p[2] * axis[1],
        p[2] * axis[0] - p[0] * axis[2],
        p[0] * axis[1] - p[1] * axis[0],
      ];
      const tLength = Math.hypot(...tangent),
        theta = (angle * Math.PI) / 180;
      const light = p.map(
        (value, i) => value * Math.sin(theta) + (tangent[i] / tLength) * Math.cos(theta),
      );
      const data = new Float32Array([
        ...c.faceUV,
        ...c.bestUV,
        ...c.parentUV,
        size,
        c.fineLayer,
        c.parentLayer,
        fade,
        ...light,
        24,
        fixture.radius,
        fixture.min,
        fixture.max,
        fixture.maxLevel,
        fixture.core,
        fixture.gutter,
        (2 * c.faceUV[2]) / 32,
        (2 * fixture.radius * c.faceUV[2]) / fixture.core,
        c.face,
        0,
        0,
        0,
      ]);
      device.queue.writeBuffer(params, 0, data);
    }
    async function read(size: number) {
      const length = size * size * 16,
        buffer = device.createBuffer({
          size: length,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffers.get(size)!, 0, buffer, 0, length);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const result = new Float32Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      return result;
    }
    async function pair(direct: Kernel, cached: Kernel, size: number) {
      for (let i = 0; i < 4; i++) {
        await run(direct, size);
        await run(cached, size);
      }
      const a: number[] = [],
        b: number[] = [];
      for (let i = 0; i < 12; i++) {
        if (i % 2) {
          b.push(await run(cached, size));
          a.push(await run(direct, size));
        } else {
          a.push(await run(direct, size));
          b.push(await run(cached, size));
        }
      }
      return {
        directMedianMs: median(a),
        cachedMedianMs: median(b),
        directRangeMs: [Math.min(...a), Math.max(...a)],
        cachedRangeMs: [Math.min(...b), Math.max(...b)],
        directSamplesMs: a,
        cachedSamplesMs: b,
        speedup: median(a) / median(b),
      };
    }
    for (let i = 0; i < 4; i++) await run("buildGradients");
    const buildTimes: number[] = [];
    for (let i = 0; i < 9; i++) buildTimes.push(await run("buildGradients"));
    const cases = [];
    for (const c of fixture.cases) {
      progress(`Checking normal accuracy: ${c.key}`);
      const checks = new Map<
        string,
        Array<{
          fade: number;
          meanDegrees: number;
          p95Degrees: number;
          maxDegrees: number | undefined;
        }>
      >();
      for (const entry of ["cachedNormals", "hybridNormals"] as const) {
        const normalError = [];
        for (const fade of [0, 0.5, 1]) {
          setParams(c, 97, fade);
          await run("directNormals", 97, 1);
          const a = await read(97);
          await run(entry, 97, 1);
          const b = await read(97);
          const angles: number[] = [];
          for (let i = 0; i < a.length; i += 4) {
            const cross = Math.hypot(
              a[i + 1] * b[i + 2] - a[i + 2] * b[i + 1],
              a[i + 2] * b[i] - a[i] * b[i + 2],
              a[i] * b[i + 1] - a[i + 1] * b[i],
            );
            const dot = a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2];
            angles.push((Math.atan2(cross, dot) * 180) / Math.PI);
          }
          if (!angles.every(Number.isFinite)) throw new Error("Non-finite normal result");
          angles.sort((a, b) => a - b);
          if (entry === "hybridNormals" && fade < 1 && angles.at(-1)! > 0.0001)
            throw new Error("Transition fallback changed the normal");
          normalError.push({
            fade,
            meanDegrees: angles.reduce((a, b) => a + b, 0) / angles.length,
            p95Degrees: angles[Math.floor(angles.length * 0.95)],
            maxDegrees: angles.at(-1),
          });
        }
        checks.set(entry, normalError);
      }
      progress(`Timing normals: ${c.key}`);
      setParams(c, 512, 0.5);
      const hybridFadeTiming = await pair("directNormals", "hybridNormals", 512);
      setParams(c);
      const normalTiming = await pair("directNormals", "cachedNormals", 512);
      const sunlight = [];
      for (const angle of [1, 60, -30]) {
        progress(`Timing sunlight: ${c.key}, Sun altitude ${angle}°`);
        setParams(c, 33, 1, angle);
        for (let i = 0; i < 3; i++) await run("buildSunlight", 33);
        const times = [];
        for (let i = 0; i < 9; i++) times.push(await run("buildSunlight", 33));
        await run("directSunlight", 33, 1);
        const a = await read(33);
        await run("cachedSunlight", 33, 1);
        const b = await read(33);
        let maxAbsoluteError = 0,
          minVisibility = 1,
          maxVisibility = 0;
        for (let i = 0; i < a.length; i += 4) {
          maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(a[i] - b[i]));
          minVisibility = Math.min(minVisibility, a[i]);
          maxVisibility = Math.max(maxVisibility, a[i]);
        }
        if (maxAbsoluteError > 1e-5) throw new Error(`Sun cache mismatch: ${maxAbsoluteError}`);
        sunlight.push({
          ...(await pair("directSunlight", "cachedSunlight", 33)),
          sunAltitudeDegrees: angle,
          buildMedianMs: median(times),
          maxAbsoluteError,
          minVisibility,
          maxVisibility,
        });
      }
      cases.push({
        key: c.key,
        normalError: checks.get("cachedNormals"),
        hybridNormalError: checks.get("hybridNormals"),
        hybridFadeTiming,
        normalTiming,
        sunlight,
      });
    }
    const digest = async (data: ArrayBuffer) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    return {
      sourceSha256: await digest(new TextEncoder().encode(shaderCode).buffer),
      heightsSha256: await digest(heightBytes),
      indexSha256: await digest(indexBytes),
      method: "Browser WebGPU compute microbenchmark; no viewer rendering or FPS",
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      timestampBatches: 256,
      fixture,
      pipelineSetupMs,
      gradientBuildAllLayersMs: median(buildTimes),
      gradientBytes: fixture.layers * fixture.width ** 2 * 8,
      normalSamples: 512 * 512,
      cases,
    };
  } finally {
    device.destroy();
  }
}
