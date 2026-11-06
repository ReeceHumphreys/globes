import {
  EquirectangularReflectionMapping,
  SRGBColorSpace,
  TextureLoader,
  type Texture,
} from "three/webgpu";

// NASA SVS Deep Star Maps (2012). A background only: it lights nothing and aligns to no body.
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
