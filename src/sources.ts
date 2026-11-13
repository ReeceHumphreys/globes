import type { GlobeBody } from "./body.ts";
import { loadImageryManifest, type ImageryManifest } from "./imagery/manifest.ts";
import { createWmtsImagery, type WmtsImagery } from "./imagery/wmts.ts";
import { createDatasetImagery } from "./imagery/dataset-source.ts";
import type { ImagerySource } from "./imagery/source.ts";
import { loadHeightTiles } from "./elevation/tiles.ts";
import { createDatasetHeights } from "./elevation/dataset-source.ts";
import type { HeightSource } from "./elevation/source.ts";

/** How sources load: URLs resolve against the page, failures are reported, not thrown. */
export interface SourceContext {
  url(path: string): string;
  body?: GlobeBody;
  signal: AbortSignal;
  report(error: unknown): void;
}

/**
 * Imagery from the `imagery` option: a source as given, a WMTS layer, or a dataset
 * manifest URL. A dataset also returns its manifest and adapter, for regional imagery.
 */
export async function resolveImagery(
  option: string | WmtsImagery | ImagerySource | undefined,
  { url, body, signal, report }: SourceContext,
): Promise<{
  source?: ImagerySource;
  dataset?: { manifest: ImageryManifest; source: ReturnType<typeof createDatasetImagery> };
}> {
  if (typeof option === "object" && "load" in option) return { source: option };
  if (typeof option === "object") return { source: createWmtsImagery(option) };
  if (typeof option !== "string") return {};
  const manifestURL = url(option);
  const manifest = await loadImageryManifest(manifestURL, body, signal).catch((error) => {
    report(error);
    return undefined;
  });
  if (!manifest) return {};
  const source = createDatasetImagery(manifest, manifestURL);
  return { source, dataset: { manifest, source } };
}

/**
 * Heights from the `elevation` option: a source as given, or a dataset manifest URL. A
 * flattened body accepts only ellipsoidal heights; the globe does not convert datums.
 */
export async function resolveHeights(
  option: string | HeightSource | undefined,
  flattening: number,
  { url, body, signal, report }: SourceContext,
): Promise<HeightSource | undefined> {
  let heights: HeightSource | undefined;
  if (typeof option === "string") {
    const heightsURL = url(option);
    const manifest = await loadHeightTiles(heightsURL, signal, body).catch((error) => {
      report(error);
      return undefined;
    });
    if (manifest) heights = createDatasetHeights(manifest, heightsURL, { onError: report });
  } else heights = option;
  if (signal.aborted) {
    heights?.dispose?.();
    return undefined;
  }
  if (heights && flattening > 0 && heights.verticalDatum !== "ellipsoid") {
    report(new Error(`Heights are from the ${heights.verticalDatum}, not the ellipsoid`));
    heights.dispose?.();
    return undefined;
  }
  return heights;
}
