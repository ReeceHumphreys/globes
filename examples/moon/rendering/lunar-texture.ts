import { TextureLoader, SRGBColorSpace, RepeatWrapping, ClampToEdgeWrapping } from "three/webgpu";
import lunarColorUrl from "./lroc-color-2k.jpg";

export async function loadLunarTexture() {
  const texture = await new TextureLoader().loadAsync(lunarColorUrl);
  texture.name = "NASA LROC global color (2K)";
  texture.colorSpace = SRGBColorSpace;
  // WGSL uses north-at-v=0. Upload the north-up JPEG without a vertical flip.
  texture.flipY = false;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
