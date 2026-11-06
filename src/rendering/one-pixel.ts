import { DataTexture, LinearFilter } from "three/webgpu";

/** A grey placeholder texture, for a shader input with nothing to read yet. */
export function onePixel(value: number) {
  const texture = new DataTexture(new Uint8Array([value, value, value, 255]), 1, 1);
  // Nearest-filtered textures get no WGSL sampler, and the shader passes one.
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
