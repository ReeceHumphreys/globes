import { matchesBody, type GlobeBody } from "../body.ts";

// Numeric, renderer-independent DEM. Rows run north to south; longitude wraps.
// Shared with the GPU as RG8 bytes (low byte, high byte), without color decoding.
export interface HeightField {
  width: number;
  height: number;
  values: Uint16Array;
  minMeters: number;
  maxMeters: number;
}

export function sampleHeight(field: HeightField, x: number, y: number, z: number): number {
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) throw new RangeError("Height sampling requires a nonzero direction.");
  const u = (Math.atan2(-z, x) + Math.PI) / (2 * Math.PI);
  const v = Math.atan2(Math.hypot(x, z), y) / Math.PI;
  const px = u * field.width - 0.5;
  const py = Math.max(0, Math.min(field.height - 1, v * field.height - 0.5));
  const left = Math.floor(px),
    top = Math.floor(py),
    fx = px - left,
    fy = py - top;
  const wrap = (i: number) => ((i % field.width) + field.width) % field.width;
  const at = (col: number, row: number) => field.values[row * field.width + wrap(col)];
  const a = at(left, top) * (1 - fx) + at(left + 1, top) * fx;
  const b =
    at(left, Math.min(top + 1, field.height - 1)) * (1 - fx) +
    at(left + 1, Math.min(top + 1, field.height - 1)) * fx;
  return (a * (1 - fy) + b * fy) * 0.5 - 10000;
}

export async function loadHeightField(
  url: string,
  options: {
    signal?: AbortSignal;
    body?: GlobeBody;
    onProgress?: (loaded: number, total: number) => void;
  } = {},
): Promise<HeightField> {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new Error(`Elevation manifest: HTTP ${response.status}`);
  const m = await response.json();
  if (
    m.version !== 1 ||
    !matchesBody(m, options.body) ||
    m.format !== "uint16-le" ||
    m.rowOrder !== "north-to-south" ||
    m.longitude !== "-180-to-180-east" ||
    m.pixelRegistration !== "centers" ||
    m.scaleMeters !== 0.5 ||
    m.offsetMeters !== -10000 ||
    !Number.isInteger(m.width) ||
    m.width < 2 ||
    m.width > 8192 ||
    !Number.isInteger(m.height) ||
    m.height < 2 ||
    m.height > 8192 ||
    !Number.isFinite(m.minMeters) ||
    !Number.isFinite(m.maxMeters) ||
    m.minMeters < -10000 ||
    m.maxMeters > 22767.5 ||
    m.minMeters > m.maxMeters ||
    m.bytes !== m.width * m.height * 2 ||
    typeof m.data !== "string"
  ) {
    throw new Error("Unsupported global elevation grid.");
  }
  const data = await fetch(new URL(m.data, url), { signal: options.signal });
  if (!data.ok) throw new Error(`Elevation data: HTTP ${data.status}`);
  let buffer: ArrayBuffer;
  if (data.body) {
    const result = new Uint8Array(m.bytes),
      reader = data.body.getReader();
    let loaded = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (loaded + chunk.value.length > m.bytes) throw new Error("Oversized elevation grid.");
        result.set(chunk.value, loaded);
        loaded += chunk.value.length;
        options.onProgress?.(loaded, m.bytes);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (loaded !== m.bytes) throw new Error("Incomplete elevation grid.");
    buffer = result.buffer;
  } else {
    buffer = await data.arrayBuffer();
    if (buffer.byteLength !== m.bytes) throw new Error("Incomplete elevation grid.");
    options.onProgress?.(buffer.byteLength, m.bytes);
  }
  // Decode little-endian explicitly; do not assume the host endianness.
  const bytes = new DataView(buffer),
    values = new Uint16Array(m.width * m.height);
  let minimum = Infinity,
    maximum = -Infinity;
  for (let i = 0; i < values.length; i++) {
    values[i] = bytes.getUint16(i * 2, true);
    const h = values[i] * 0.5 - 10000;
    minimum = Math.min(minimum, h);
    maximum = Math.max(maximum, h);
  }
  if (minimum !== m.minMeters || maximum !== m.maxMeters)
    throw new Error("Elevation bounds do not match data.");
  return { width: m.width, height: m.height, values, minMeters: minimum, maxMeters: maximum };
}
