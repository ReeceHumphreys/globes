import { DataTexture, RGFormat, UnsignedByteType, NearestFilter, NoColorSpace } from "three/webgpu";
import type { HeightField } from "../elevation/height-field.ts";

export function createElevationTexture(field?: HeightField): DataTexture {
  const values = field?.values ?? new Uint16Array([20000]); // Exactly zero meters.
  const bytes = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    bytes[i * 2] = values[i] & 255;
    bytes[i * 2 + 1] = values[i] >> 8;
  }
  const map = new DataTexture(
    bytes,
    field?.width ?? 1,
    field?.height ?? 1,
    RGFormat,
    UnsignedByteType,
  );
  map.name = "Global terrain heights (numeric RG8)";
  map.colorSpace = NoColorSpace;
  map.minFilter = NearestFilter;
  map.magFilter = NearestFilter;
  map.flipY = false;
  map.generateMipmaps = false;
  map.unpackAlignment = 1;
  map.needsUpdate = true;
  return map;
}
