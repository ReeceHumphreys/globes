import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

/**
 * A soft photographic glow on the brightest light, such as sun glint and the lit limb.
 * Call `render()` on the result in place of `renderer.render(scene, camera)`.
 */
export function createBloom(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): THREE.RenderPipeline {
  const pipeline = new THREE.RenderPipeline(renderer);
  const color = pass(scene, camera).getTextureNode();
  pipeline.outputNode = color.add(bloom(color, 0.12, 0.5, 0.9));
  return pipeline;
}
