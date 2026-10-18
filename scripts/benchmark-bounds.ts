import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { createWasmHeightBounds } from "../src/elevation/bounds-wasm.ts";
import { createHeightBounds } from "../src/elevation/bounds.ts";
const elevation = process.env.TILE_ROOT
  ? `${process.env.TILE_ROOT}/moon/elevation`
  : "../tile-service/public/data/moon/elevation";
const manifest = JSON.parse(fs.readFileSync(`${elevation}/manifest.json`, "utf8"));
const bytes = fs.readFileSync(`${elevation}/heights.u16`);
const field = {
  ...manifest,
  values: new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2),
};
const compileStart = performance.now();
const module = await WebAssembly.compile(fs.readFileSync("native/elevation-bounds.wasm"));
const compileMs = performance.now() - compileStart;
const functions = {
  typescript: createHeightBounds,
  wasm: (field) => createWasmHeightBounds(field, module),
};
const samples = { typescript: [], wasm: [] };
const cold = {};
let checksum = 0;
for (let round = 0; round < 7; round++) {
  for (const name of round % 2 ? ["wasm", "typescript"] : ["typescript", "wasm"]) {
    const start = performance.now(),
      bounds = await functions[name](field),
      ms = performance.now() - start;
    if (round === 0) cold[name] = ms;
    else samples[name].push(ms);
    checksum += bounds.levels.at(-1).maximum[0] + bounds.maxStepX + bounds.maxStepY;
  }
}
const summarize = (data) => {
  const sorted = data.toSorted((a, b) => a - b);
  return {
    medianMs: (sorted[2] + sorted[3]) / 2,
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    samplesMs: data,
  };
};
const results = { typescript: summarize(samples.typescript), wasm: summarize(samples.wasm) };
const report = {
  dataset: "Prepared NASA LOLA 5760x2880 global DEM",
  runtime: process.version,
  platform: `${process.platform}/${process.arch}`,
  scope:
    "One-time elevation bounds construction only. Wasm includes instantiation, input copy, kernel, output copy and free. Compilation measured separately; no download, GPU work, tile selection or instance packing.",
  coldMs: cold,
  compileMs,
  results,
  medianSpeedup: results.typescript.medianMs / results.wasm.medianMs,
  checksum,
};
console.info(JSON.stringify(report, null, 2));
