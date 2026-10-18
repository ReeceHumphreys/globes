import { Data3DTexture, LinearFilter, RepeatWrapping, RedFormat, NoColorSpace } from "three/webgpu";

export interface CloudNoise {
  shape: Data3DTexture;
  detail: Data3DTexture;
}

/** Upstream assets are tightly packed R8 volumes, not images or LFS pointers. */
export function decodeCloudNoise(data: Uint8Array, size: number): Data3DTexture {
  if (!Number.isInteger(size) || size < 1 || size > 256 || data.byteLength !== size ** 3)
    throw new RangeError(
      `Cloud noise requires ${size}³ R8 samples; received ${data.byteLength} bytes`,
    );
  const volume = new Data3DTexture(data, size, size, size);
  volume.format = RedFormat;
  volume.colorSpace = NoColorSpace;
  volume.minFilter = volume.magFilter = LinearFilter;
  volume.wrapS = volume.wrapT = volume.wrapR = RepeatWrapping;
  volume.generateMipmaps = false;
  volume.unpackAlignment = 1;
  volume.needsUpdate = true;
  return volume;
}

export async function loadCloudNoise(shapeURL: string, detailURL: string, signal: AbortSignal) {
  const read = async (url: string) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Cloud noise request failed: ${response.status} ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [shapeBytes, detailBytes] = await Promise.all([read(shapeURL), read(detailURL)]);
  signal.throwIfAborted();
  const shape = decodeCloudNoise(shapeBytes, 128);
  try {
    const detail = decodeCloudNoise(detailBytes, 32);
    return {
      shape,
      detail,
      dispose() {
        shape.dispose();
        detail.dispose();
      },
    };
  } catch (error) {
    shape.dispose();
    throw error;
  }
}
