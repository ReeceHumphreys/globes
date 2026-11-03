import {
  DataTexture,
  RedFormat,
  NoColorSpace,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  ClampToEdgeWrapping,
} from "three/webgpu";

export const OCEAN_MASK_WIDTH = 4096;
export const OCEAN_MASK_HEIGHT = 2048;

/** Caller owns the texture. R8 stays bounded to 8 MiB plus mipmaps on the GPU. */
export function decodeOceanMask(bytes: Uint8Array): DataTexture {
  if (bytes.length !== OCEAN_MASK_WIDTH * OCEAN_MASK_HEIGHT)
    throw new RangeError("Invalid ocean mask size");
  const texture = new DataTexture(bytes, OCEAN_MASK_WIDTH, OCEAN_MASK_HEIGHT, RedFormat);
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export async function loadOceanMask(url: string, signal: AbortSignal): Promise<DataTexture> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Ocean mask: HTTP ${response.status}`);
  // Vite serves .gz with Content-Encoding:gzip, so Fetch may have already
  // decoded it. A static/CDN host can instead deliver the compressed payload.
  const payload = new Uint8Array(await response.arrayBuffer());
  const bytes =
    payload[0] === 0x1f && payload[1] === 0x8b
      ? new Uint8Array(
          await new Response(
            new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip")),
          ).arrayBuffer(),
        )
      : payload;
  signal.throwIfAborted();
  return decodeOceanMask(bytes);
}
