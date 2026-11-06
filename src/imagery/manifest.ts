import { validateTileStorage, type PMTilesStorage } from "../tiles/tile-source.ts";
import { matchesBody, type GlobeBody } from "../body.ts";

// Manifest written by the offline imagery tool. Addresses match terrain tiles.
export interface ImageryManifest {
  storage?: PMTilesStorage;
  version: 1;
  id: string;
  title: string;
  body: string;
  radiusMeters: number;
  projection: "normalized-cube";
  coverage: { west: number; east: number; south: number; north: number };
  faces: Array<{
    id: number;
    name: string;
    normal: number[];
    uAxis: number[];
    vAxis: number[];
  }>;
  axes: { north: "+Y"; longitude0: "+X"; longitude90East: "-Z" };
  addressing: {
    origin: "bottom-left in face-local UV";
    yDirection: "up";
    template: string; // Relative to manifest URL: {face}/{level}/{x}/{y}.png
  };
  tileSize: number; // Core pixels excluding gutter.
  gutter: number;
  imageSize: number;
  imageRowOrder: "top-to-bottom";
  textureFlipY: true;
  textureUV: { offset: number; scale: number };
  minLevel: number;
  maxLevel: number;
  tileCount: number;
  format: "png";
  channels: "RGBA";
  noData: string;
  colorSpace: "srgb";
  resampling: "average";
  sampler: {
    minFilter: "linear";
    magFilter: "linear";
    generateMipmaps: false;
    anisotropy: 1;
    wrapS: "clamp-to-edge";
    wrapT: "clamp-to-edge";
  };
  nativeResolutionMeters: number;
  faceCenterMetersPerPixelAtMaxLevel: number;
  quantity: string;
  source: {
    url: string;
    page: string;
    credit: string;
    sha256: string;
    crsWkt: string;
    width: number;
    height: number;
    bands: number;
    dtype: string;
    nodata: number | null;
    transform: number[];
  };
  generation: { strategy: "cached" | "direct"; pngCompression: number };
  pipelineVersion: number;
  toolchain: Record<string, string>;
}

export function parseImageryManifest(value: unknown, expectedBody?: GlobeBody): ImageryManifest {
  const m = value as ImageryManifest;
  if (
    !m ||
    m.version !== 1 ||
    !matchesBody(m, expectedBody) ||
    m.projection !== "normalized-cube" ||
    m.axes?.north !== "+Y" ||
    m.axes?.longitude0 !== "+X" ||
    m.axes?.longitude90East !== "-Z" ||
    m.addressing?.template !== "{face}/{level}/{x}/{y}.png" ||
    m.addressing?.yDirection !== "up" ||
    m.textureFlipY !== true ||
    m.format !== "png" ||
    m.colorSpace !== "srgb" ||
    m.minLevel !== 0 ||
    !Number.isInteger(m.maxLevel) ||
    m.maxLevel < 0 ||
    m.maxLevel > 20 ||
    !Number.isInteger(m.tileSize) ||
    m.tileSize < 1 ||
    m.tileSize > 2048 ||
    !Number.isInteger(m.gutter) ||
    m.gutter < 1 ||
    m.gutter > 16 ||
    m.imageSize !== m.tileSize + 2 * m.gutter ||
    m.textureUV?.offset !== m.gutter / m.imageSize ||
    m.textureUV?.scale !== m.tileSize / m.imageSize
  ) {
    throw new Error("Unsupported globe imagery manifest or coordinate convention.");
  }
  validateTileStorage(m.storage);
  return m;
}

/** A generated dataset is absent (including SPA servers returning index.html). */
export class MissingImageryManifestError extends Error {}

/**
 * Fetch and validate an imagery manifest. Rejects if it is missing, malformed, or
 * published for a body other than `expectedBody`.
 */
export async function loadImageryManifest(
  url: string,
  expectedBody?: GlobeBody,
  signal?: AbortSignal,
): Promise<ImageryManifest> {
  const response = await fetch(url, { signal });
  if (response.status === 404)
    throw new MissingImageryManifestError(`Imagery manifest not found: ${url} (HTTP 404)`);
  if (!response.ok) throw new Error(`Imagery manifest: HTTP ${response.status} at ${url}`);
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/html") || /^\s*</.test(text))
    throw new MissingImageryManifestError(
      `Imagery manifest not found at ${url}: the server returned HTML instead of JSON. Generate the dataset or correct the imagery URL.`,
    );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in imagery manifest at ${url}`);
  }
  return parseImageryManifest(value, expectedBody);
}
