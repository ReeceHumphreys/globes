// Kept apart from bounds-wasm.ts so Node tests can import the kernel without Vite's ?url.
import wasmURL from "../../native/elevation-bounds.wasm?url";
import { createWasmHeightBounds } from "./bounds-wasm.ts";
import type { HeightField } from "./height-field.ts";

export async function loadElevationBounds(field: HeightField, signal?: AbortSignal) {
  const response = await fetch(wasmURL, { signal });
  if (!response.ok) throw new Error(`Elevation bounds Wasm: HTTP ${response.status}`);
  const module = await WebAssembly.compile(await response.arrayBuffer());
  signal?.throwIfAborted();
  return createWasmHeightBounds(field, module);
}
