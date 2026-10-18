import {
  EquirectangularReflectionMapping,
  SRGBColorSpace,
  TextureLoader,
  type Texture,
} from "three/webgpu";

// NASA SVS Deep Star Maps (2012). Only a background: it does not illuminate
// the terrain, and its orientation is not yet tied to a lunar inertial frame.
export async function loadStarBackground(): Promise<Texture> {
  const url = new URL(
    "data/sky/nasa-starmap-4k.jpg",
    new URL(import.meta.env.BASE_URL, window.location.href),
  );
  const texture = await new TextureLoader().loadAsync(url.href);
  texture.name = "NASA SVS Deep Star Maps · 4K";
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
