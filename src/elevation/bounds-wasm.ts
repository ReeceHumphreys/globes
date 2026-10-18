import type { HeightField } from "./height-field.ts";
import type { HeightBounds } from "./bounds.ts";

interface BoundsExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  bounds_alloc: (bytes: number) => number;
  bounds_free: (pointer: number) => void;
  bounds_build: (width: number, height: number, input: number, output: number) => number;
}

// The module can be cached; each build uses temporary Wasm memory. Returned
// arrays are ordinary JS-owned buffers, never borrowed pointers or GPU bindings.
export async function createWasmHeightBounds(
  field: HeightField,
  module: WebAssembly.Module,
): Promise<HeightBounds> {
  const { width, height, values } = field;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    !(values instanceof Uint16Array) ||
    values.length !== width * height
  )
    throw new RangeError("Invalid elevation dimensions or samples.");
  const dimensions: { width: number; height: number }[] = [];
  let w = width,
    h = height,
    words = 2 * height + 2;
  while (w > 1 || h > 1) {
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
    dimensions.push({ width: w, height: h });
    words += 2 * w * h;
  }
  const instance = await WebAssembly.instantiate(module, {});
  const native = instance.exports as BoundsExports;
  const input = native.bounds_alloc((values.length + words) * 2);
  if (!input) throw new Error("Elevation bounds allocation failed.");
  try {
    // Allocate before binding, since allocation can grow the Wasm memory.
    new Uint16Array(native.memory.buffer, input, values.length).set(values);
    const output = input + values.byteLength;
    if (native.bounds_build(width, height, input, output) !== 0)
      throw new Error("Elevation bounds construction failed.");
    // One copy out, then small typed views over the JS-owned result. The original
    // field remains level zero, matching the TypeScript bounds/query interface.
    const data = new Uint16Array(native.memory.buffer, output, words).slice();
    const levels: HeightBounds["levels"] = [{ width, height, minimum: values, maximum: values }];
    let offset = 0;
    for (const size of dimensions) {
      const length = size.width * size.height;
      const minimum = data.subarray(offset, offset + length);
      offset += length;
      const maximum = data.subarray(offset, offset + length);
      offset += length;
      levels.push({ ...size, minimum, maximum });
    }
    const rowMinimum = data.subarray(offset, offset + height);
    offset += height;
    const rowMaximum = data.subarray(offset, offset + height);
    offset += height;
    return {
      width,
      height,
      field,
      levels,
      rowMinimum,
      rowMaximum,
      maxStepX: data[offset] * 0.5,
      maxStepY: data[offset + 1] * 0.5,
    };
  } finally {
    native.bounds_free(input);
    // No instance is retained: its entire linear memory can be collected.
  }
}
