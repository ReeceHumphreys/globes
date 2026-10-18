import { sampleHeight, type HeightField } from "./height-field.ts";

// Numeric min/max hierarchy. Each level bounds 2x2 blocks of the preceding one.
// Unlike image mipmaps, averaging would lose peaks and valleys and is unsafe.
export interface HeightBounds {
  width: number;
  height: number;
  rowMinimum: Uint16Array;
  rowMaximum: Uint16Array;
  field: HeightField;
  maxStepX: number;
  maxStepY: number;
  levels: { width: number; height: number; minimum: Uint16Array; maximum: Uint16Array }[];
}
export function createHeightBounds(field: HeightField): HeightBounds {
  const levels: HeightBounds["levels"] = [
    { width: field.width, height: field.height, minimum: field.values, maximum: field.values },
  ];
  while (levels.at(-1)!.width > 1 || levels.at(-1)!.height > 1) {
    const previous = levels.at(-1)!;
    const width = Math.ceil(previous.width / 2),
      height = Math.ceil(previous.height / 2);
    const minimum = new Uint16Array(width * height),
      maximum = new Uint16Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let lo = 65535,
          hi = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const px = x * 2 + dx,
              py = y * 2 + dy;
            if (px >= previous.width || py >= previous.height) continue;
            const i = py * previous.width + px;
            lo = Math.min(lo, previous.minimum[i]);
            hi = Math.max(hi, previous.maximum[i]);
          }
        minimum[y * width + x] = lo;
        maximum[y * width + x] = hi;
      }
    levels.push({ width, height, minimum, maximum });
  }
  const rowMinimum = new Uint16Array(field.height),
    rowMaximum = new Uint16Array(field.height);
  let maxStepX = 0,
    maxStepY = 0;
  for (let y = 0; y < field.height; y++) {
    let low = 65535,
      high = 0;
    for (let x = 0; x < field.width; x++) {
      const value = field.values[y * field.width + x];
      maxStepX = Math.max(
        maxStepX,
        Math.abs(value - field.values[y * field.width + ((x + 1) % field.width)]) * 0.5,
      );
      if (y + 1 < field.height)
        maxStepY = Math.max(
          maxStepY,
          Math.abs(value - field.values[(y + 1) * field.width + x]) * 0.5,
        );
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    rowMinimum[y] = low;
    rowMaximum[y] = high;
  }
  return {
    width: field.width,
    height: field.height,
    levels,
    rowMinimum,
    rowMaximum,
    field,
    maxStepX,
    maxStepY,
  };
}

// Enclose a spherical tile by an angular cap, then bound every source texel that
// can influence it. Query at most four hierarchy cells per longitude interval.
// Caller supplies reusable output [minMeters,maxMeters]. No hot-path allocations.
export function heightBoundsForCap(
  bounds: HeightBounds,
  x: number,
  y: number,
  z: number,
  chord: number,
  out: Float64Array,
): void {
  const angle = 2 * Math.asin(Math.min(1, chord / 2));
  const latitude = Math.asin(Math.max(-1, Math.min(1, y)));
  const top = Math.max(0, Math.floor((0.5 - (latitude + angle) / Math.PI) * bounds.height - 0.5));
  const bottom = Math.min(
    bounds.height - 1,
    Math.ceil((0.5 - (latitude - angle) / Math.PI) * bounds.height - 0.5),
  );
  const longitude = Math.atan2(-z, x);
  let half = Math.PI;
  if (Math.abs(latitude) + angle < Math.PI / 2)
    half = Math.asin(Math.min(1, Math.sin(angle) / Math.cos(latitude)));
  const left = Math.floor(((longitude - half) / (2 * Math.PI) + 0.5) * bounds.width - 0.5);
  const right = Math.ceil(((longitude + half) / (2 * Math.PI) + 0.5) * bounds.width - 0.5);
  let minimum = 65535,
    maximum = 0;
  function rectangle(a: number, b: number): void {
    const level = Math.min(
      bounds.levels.length - 1,
      Math.max(0, Math.ceil(Math.log2(Math.max(b - a + 1, bottom - top + 1)))),
    );
    const scale = 2 ** level,
      grid = bounds.levels[level];
    for (let row = Math.floor(top / scale); row <= Math.floor(bottom / scale); row++) {
      for (let col = Math.floor(a / scale); col <= Math.floor(b / scale); col++) {
        const i = row * grid.width + col;
        minimum = Math.min(minimum, grid.minimum[i]);
        maximum = Math.max(maximum, grid.maximum[i]);
      }
    }
  }
  if (right - left + 1 >= bounds.width || right - left + 1 > 8 * (bottom - top + 1)) {
    // A thin polar cap can span every longitude. A square hierarchy query would
    // unnecessarily include distant latitudes; use conservative row bounds.
    for (let row = top; row <= bottom; row++) {
      minimum = Math.min(minimum, bounds.rowMinimum[row]);
      maximum = Math.max(maximum, bounds.rowMaximum[row]);
    }
  } else if (left < 0) {
    rectangle(0, right);
    rectangle(left + bounds.width, bounds.width - 1);
  } else if (right >= bounds.width) {
    rectangle(left, bounds.width - 1);
    rectangle(0, right - bounds.width);
  } else rectangle(left, right);
  // A texel min/max alone never tightens below one source cell. Intersect it
  // with a global derivative bound so tiny geometry tiles have tiny bounds too.
  const center = sampleHeight(bounds.field, x, y, z);
  const deviation =
    ((bounds.maxStepX * half) / (2 * Math.PI)) * bounds.width +
    ((bounds.maxStepY * angle) / Math.PI) * bounds.height;
  out[0] = Math.max(minimum * 0.5 - 10000, center - deviation);
  out[1] = Math.min(maximum * 0.5 - 10000, center + deviation);
}
