import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real shader files run on a real GPU, through headless Chrome, so a test can compare them
// with the CPU code they must agree with. Chrome is the only WebGPU this repo can reach.
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface WgslRun {
  /** WGSL source: the functions under test and what they need. */
  wgsl: string[];
  /** A vec4<f32> expression over `a` and `b`, each case's two input vectors. */
  expression: string;
  /** Up to eight floats per case, as `a` then `b`. */
  cases: readonly (readonly number[])[];
  /** An rgba16float texture bound as `lut`, with a linear `lutSampler`. */
  lut?: { width: number; height: number; halves: Uint16Array };
}

export interface Gpu {
  run(job: WgslRun): Promise<number[][]>;
  close(): void;
}

// Runs in the page, so it can use nothing from this module.
async function runInPage(
  source: string,
  flat: number[],
  count: number,
  lutBase64?: string,
  lutSize?: number[],
) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: source });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}: ${m.message}`).join("\n"));
  const input = device.createBuffer({
    size: flat.length * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(input, 0, new Float32Array(flat));
  const bytes = count * 16;
  const output = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const read = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const entries: GPUBindGroupEntry[] = [
    { binding: 0, resource: { buffer: input } },
    { binding: 1, resource: { buffer: output } },
  ];
  if (lutBase64 && lutSize) {
    const [width, height] = lutSize;
    const texture = device.createTexture({
      size: [width, height],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const data = Uint8Array.from(atob(lutBase64), (c) => c.charCodeAt(0));
    device.queue.writeTexture({ texture }, data, { bytesPerRow: width * 8 }, [width, height]);
    entries.push({ binding: 2, resource: texture.createView() });
    entries.push({
      binding: 3,
      resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }),
    });
  }
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
  pass.dispatchWorkgroups(Math.ceil(count / 64));
  pass.end();
  encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  return Array.from(new Float32Array(read.getMappedRange()));
}

function kernel({ wgsl, expression, lut }: WgslRun) {
  return `
@group(0) @binding(0) var<storage, read> cases: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4<f32>>;
${lut ? "@group(0) @binding(2) var lut: texture_2d<f32>;\n@group(0) @binding(3) var lutSampler: sampler;" : ""}
${wgsl.join("\n")}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&results)) { return; }
  let a = cases[i * 2u];
  let b = cases[i * 2u + 1u];
  results[i] = ${expression};
}`;
}

/** Opens headless Chrome, or returns undefined where it or WebGPU is missing. */
export async function openGpu(): Promise<Gpu | undefined> {
  if (!existsSync(CHROME)) return undefined;
  // WebGPU needs a secure context, which a page on localhost is.
  const server = createServer((_, response) => response.end("<!doctype html>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const page = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const profile = mkdtempSync(join(tmpdir(), "wgsl-"));
  const browser = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--enable-unsafe-webgpu",
      "--no-first-run",
      page,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const close = () => {
    browser.kill();
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  const debuggerPort = await new Promise<string>((resolve, reject) => {
    let text = "";
    browser.stderr.on("data", (chunk) => {
      text += chunk;
      const found = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text);
      if (found) resolve(found[1]);
    });
    browser.once("exit", () => reject(new Error("Chrome exited")));
  });
  let target: string | undefined;
  for (let i = 0; i < 40 && !target; i++) {
    const tabs = (await fetch(`http://127.0.0.1:${debuggerPort}/json`).then((r) => r.json())) as {
      url: string;
      webSocketDebuggerUrl: string;
    }[];
    target = tabs.find((tab) => tab.url === page)?.webSocketDebuggerUrl;
    if (!target) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!target) {
    close();
    return undefined;
  }
  const socket = new WebSocket(target);
  await new Promise((resolve) => (socket.onopen = resolve));
  let id = 0;
  const evaluate = (expression: string) =>
    new Promise<unknown>((resolve, reject) => {
      const request = ++id;
      const listen = (event: MessageEvent) => {
        const message = JSON.parse(event.data as string);
        if (message.id !== request) return;
        socket.removeEventListener("message", listen);
        const { result, exceptionDetails } = message.result;
        if (exceptionDetails)
          reject(new Error(exceptionDetails.exception?.description ?? exceptionDetails.text));
        else resolve(result.value);
      };
      socket.addEventListener("message", listen);
      socket.send(
        JSON.stringify({
          id: request,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  if (!(await evaluate(`(async () => !!(await navigator.gpu?.requestAdapter()))()`))) {
    close();
    return undefined;
  }
  return {
    async run(job) {
      const flat = job.cases.flatMap((values) =>
        Array.from({ length: 8 }, (_, i) => values[i] ?? 0),
      );
      const lut = job.lut && Buffer.from(job.lut.halves.buffer).toString("base64");
      const args = [
        kernel(job),
        flat,
        job.cases.length,
        lut,
        job.lut && [job.lut.width, job.lut.height],
      ];
      const values = (await evaluate(
        `(${runInPage.toString()})(...${JSON.stringify(args.map((v) => v ?? null))}.map((v) => v ?? undefined))`,
      )) as number[];
      return job.cases.map((_, i) => values.slice(i * 4, i * 4 + 4));
    },
    close,
  };
}
