import { validateTileStorage, type PMTilesStorage } from "../tiles/tile-source.ts";
import { matchesBody, type GlobeBody } from "../body.ts";
import { MAX_LEVEL } from "../tiles/roots.ts";

/** An imagery manifest, as the dataset contract defines it. */
export interface ImageryManifest {
  storage?: PMTilesStorage;
  version: 2;
  id: string;
  body: string;
  radiusMeters: number;
  projection: "geographic-polar";
  format: "png";
  colorSpace: "srgb";
  tileSize: number; // Core pixels excluding gutter.
  gutter: number;
  maxLevel: number; // A dataset level.
  title?: string;
}

const DESCRIPTION = [
  "title",
  "coverage",
  "quantity",
  "nativeResolutionMeters",
  "source",
  "producer",
];

export function parseImageryManifest(value: unknown, expectedBody?: GlobeBody): ImageryManifest {
  const m = value as ImageryManifest;
  if (
    !m ||
    m.version !== 2 ||
    typeof m.id !== "string" ||
    m.id === "" ||
    !matchesBody(m, expectedBody) ||
    m.projection !== "geographic-polar" ||
    m.format !== "png" ||
    m.colorSpace !== "srgb" ||
    !Number.isInteger(m.maxLevel) ||
    m.maxLevel < 0 ||
    m.maxLevel > MAX_LEVEL ||
    !Number.isInteger(m.tileSize) ||
    m.tileSize < 1 ||
    m.tileSize > 2048 ||
    !Number.isInteger(m.gutter) ||
    m.gutter < 1 ||
    m.gutter > 16 ||
    DESCRIPTION.some((key) => (m as unknown as Record<string, unknown>)[key] === null)
  ) {
    throw new Error("Unsupported imagery manifest.");
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
