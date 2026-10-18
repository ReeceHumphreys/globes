import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createWasmHeightBounds } from "../src/elevation/bounds-wasm.ts";
import { createHeightBounds, heightBoundsForCap } from "../src/elevation/bounds.ts";
const bytes = fs.readFileSync(new URL("../native/elevation-bounds.wasm", import.meta.url));
const module = await WebAssembly.compile(bytes);
function field(width, height) {
  let seed = 123456;
  const values = new Uint16Array(width * height);
  for (let i = 0; i < values.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    values[i] = seed >>> 16;
  }
  return { width, height, values, minMeters: -10000, maxMeters: 22767.5 };
}
function sameArray(actual, expected, label) {
  assert.equal(actual.length, expected.length, label);
  assert.equal(
    Buffer.compare(
      Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength),
      Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
    ),
    0,
    label,
  );
}
function sameBounds(actual, expected) {
  assert.equal(actual.width, expected.width);
  assert.equal(actual.height, expected.height);
  assert.equal(actual.field, expected.field);
  assert.equal(actual.maxStepX, expected.maxStepX);
  assert.equal(actual.maxStepY, expected.maxStepY);
  sameArray(actual.rowMinimum, expected.rowMinimum, "row minima");
  sameArray(actual.rowMaximum, expected.rowMaximum, "row maxima");
  assert.equal(actual.levels.length, expected.levels.length);
  actual.levels.forEach((level, i) => {
    assert.equal(level.width, expected.levels[i].width);
    assert.equal(level.height, expected.levels[i].height);
    sameArray(level.minimum, expected.levels[i].minimum, `level ${i} minima`);
    sameArray(level.maximum, expected.levels[i].maximum, `level ${i} maxima`);
  });
}
test("one-shot C++ bounds exactly match TypeScript for odd, narrow, constant and extreme grids", async () => {
  for (const [w, h] of [
    [1, 1],
    [1, 7],
    [9, 1],
    [3, 5],
    [128, 64],
    [127, 65],
  ]) {
    const f = field(w, h),
      original = f.values.slice();
    const actual = await createWasmHeightBounds(f, module),
      expected = createHeightBounds(f);
    sameBounds(actual, expected);
    sameArray(f.values, original, "input unchanged");
    assert.equal(actual.levels[0].minimum, f.values);
    for (const [x, y, z, chord] of [
      [1, 0, 0, 0.1],
      [-1, 0, 0, 0.2],
      [0, 1, 0, 0.01],
      [0, -1, 0, 0.1],
    ]) {
      const a = new Float64Array(2),
        b = new Float64Array(2);
      heightBoundsForCap(actual, x, y, z, chord, a);
      heightBoundsForCap(expected, x, y, z, chord, b);
      assert.deepEqual(a, b);
    }
  }
  const f = field(7, 3);
  f.values.fill(20000);
  sameBounds(await createWasmHeightBounds(f, module), createHeightBounds(f));
  f.values[0] = 0;
  f.values[1] = 65535;
  sameBounds(await createWasmHeightBounds(f, module), createHeightBounds(f));
});
test("bounds return JS-owned arrays that remain valid after another build", async () => {
  const first = await createWasmHeightBounds(field(513, 257), module);
  const saved = first.levels[1].minimum.slice();
  const next = await createWasmHeightBounds(field(1024, 512), module);
  assert.notEqual(first.levels[1].minimum.buffer, next.levels[1].minimum.buffer);
  sameArray(first.levels[1].minimum, saved, "first result survives independent build");
});
test("invalid bounds inputs fail before native allocation", async () => {
  const f = field(3, 5);
  for (const invalid of [
    { ...f, width: 0 },
    { ...f, width: 2.5 },
    { ...f, height: 8193 },
    { ...f, values: new Uint16Array(1) },
    { ...f, values: new Float32Array(15) },
  ]) {
    await assert.rejects(createWasmHeightBounds(invalid, module), RangeError);
  }
});
test("shipped bounds Wasm matches source and exposes only the small numeric interface", () => {
  const receipt = JSON.parse(
    fs.readFileSync(new URL("../native/elevation-bounds-build.json", import.meta.url), "utf8"),
  );
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  assert.equal(
    hash(fs.readFileSync(new URL("../native/elevation-bounds.cpp", import.meta.url))),
    receipt.sourceSha256,
    "run npm run wasm:build",
  );
  assert.equal(hash(bytes), receipt.wasmSha256);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.deepEqual(
    WebAssembly.Module.exports(module)
      .map((e) => e.name)
      .sort(),
    ["bounds_alloc", "bounds_build", "bounds_free", "memory"],
  );
});
test(
  "native bounds match the actual NASA DEM at every hierarchy cell",
  { skip: !fs.existsSync("../tile-service/public/data/moon/elevation/heights.u16") },
  async () => {
    const manifest = JSON.parse(
      fs.readFileSync("../tile-service/public/data/moon/elevation/manifest.json", "utf8"),
    );
    const data = fs.readFileSync("../tile-service/public/data/moon/elevation/heights.u16");
    const f = {
      ...manifest,
      values: new Uint16Array(data.buffer, data.byteOffset, data.length / 2),
    };
    sameBounds(await createWasmHeightBounds(f, module), createHeightBounds(f));
  },
);
