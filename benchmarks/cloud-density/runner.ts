import densitySource from "../../examples/planets/shaders/cloud-density.wgsl?raw";
import { densityCases, upstreamDensity } from "./reference.ts";

// WebGPU bit flags, matching the existing terrain-cache benchmark.
const GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };
const GPUMapMode = { READ: 1 };

async function run() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU is required");
  const device = await adapter.requestDevice();
  try {
    const cases = densityCases();
    const samples = new Float32Array(cases.length * 8);
    cases.forEach((c, i) =>
      samples.set(
        [c.height, c.weather, c.shape, c.detail, c.coverage, c.detailAmount, 0, 0],
        i * 8,
      ),
    );
    const module = device.createShaderModule({
      code:
        densitySource +
        `
      @group(0) @binding(0) var<storage,read> inputs: array<vec4<f32>>;
      @group(0) @binding(1) var<storage,read_write> outputs: array<f32>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        if (id.x >= ${cases.length}u) { return; }
        let a=inputs[id.x*2u]; let b=inputs[id.x*2u+1u];
        outputs[id.x]=cloudDensityFromSamples(a.x,a.y,a.z,a.w,b.x,b.y);
      }`,
    });
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
    if (errors.length) throw new Error(errors.map((e) => e.message).join("\n"));
    const input = device.createBuffer({
      size: samples.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(input, 0, samples);
    const output = device.createBuffer({
      size: cases.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const read = device.createBuffer({
      size: cases.length * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(cases.length / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, read.size);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(read.getMappedRange());
    let error = 0;
    cases.forEach((c, i) => {
      if (!Number.isFinite(actual[i])) throw new Error(`Non-finite result at ${i}`);
      error = Math.max(error, Math.abs(actual[i] - upstreamDensity(c)));
    });
    read.unmap();
    input.destroy();
    output.destroy();
    read.destroy();
    if (error > 2e-6) throw new Error(`Density mismatch: ${error}`);
    return { cases: cases.length, maxAbsoluteError: error, tolerance: 2e-6, pass: true };
  } finally {
    device.destroy();
  }
}
void run()
  .then((result) => {
    document.querySelector("#result")!.textContent = JSON.stringify(result, null, 2);
  })
  .catch((error) => {
    document.querySelector("#result")!.textContent = String(error);
    console.error(error);
  });
