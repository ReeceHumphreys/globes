import * as THREE from "three/webgpu";
import { LensflareMesh, LensflareElement } from "three/addons/objects/LensflareMesh.js";
import { defaultSunDirection } from "./sun.ts";
import type { GlobeContext, GlobeFrame } from "../composition.ts";

// Approximate apparent diameter at 1 AU. The disk keeps this angle at every
// zoom level; its scene distance is only a rendering convenience.
const SUN_DIAMETER_RAD = THREE.MathUtils.degToRad(0.533);
const FLARE_SIZES = [150, 38, 65] as const;

function glowTexture(disk: boolean): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create the Sun texture");
  const glow = context.createRadialGradient(256, 256, disk ? 64 : 0, 256, 256, 256);
  glow.addColorStop(0, "rgba(255,248,230,0.18)");
  glow.addColorStop(0.12, "rgba(255,240,215,0.065)");
  glow.addColorStop(0.4, "rgba(255,240,215,0.012)");
  glow.addColorStop(1, "rgba(255,240,215,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 512, 512);
  if (disk) {
    context.fillStyle = "#fffdf8";
    context.beginPath();
    context.arc(256, 256, 64, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createSunObjects(angularDiameterRad: number) {
  const group = new THREE.Group();
  group.name = "Sun and optical flare";
  const direction = new THREE.Vector3(...defaultSunDirection());
  const diskTexture = glowTexture(true);
  const material = new THREE.SpriteNodeMaterial({
    map: diskTexture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const disk = new THREE.Sprite(material);
  disk.name = "Sun · 0.533 degree disk";
  disk.frustumCulled = false;
  const flareTexture = glowTexture(false);
  // The WebGPU addon checks the rendered depth buffer, so terrain hides the
  // flare too. A geometric ray/sphere test would miss real mountains.
  const flare = new LensflareMesh();
  flare.name = "Sun lens flare";
  const elements = [
    new LensflareElement(flareTexture, FLARE_SIZES[0], 0, new THREE.Color(0.5, 0.47, 0.4)),
    new LensflareElement(flareTexture, FLARE_SIZES[1], 0.45, new THREE.Color(0.12, 0.18, 0.2)),
    new LensflareElement(flareTexture, FLARE_SIZES[2], 0.85, new THREE.Color(0.15, 0.11, 0.07)),
  ];
  for (const element of elements) flare.addElement(element);
  group.add(disk, flare);
  return {
    group,
    setSun(x: number, y: number, z: number): void {
      direction.set(x, y, z).normalize();
    },
    setFlareEnabled(enabled: boolean): void {
      flare.visible = enabled;
    },
    update({ context }: GlobeFrame): void {
      const { camera } = context;
      const pixelRatio = context.viewport.pixelRatio;
      direction.copy(context.sun.direction);
      // Follow translation while keeping a fixed celestial direction. Place
      // beyond the globe but inside the dynamically adjusted clipping plane.
      group.position.copy(camera.position);
      const distance = camera.far * 0.99;
      disk.position.copy(direction).multiplyScalar(distance);
      flare.position.copy(disk.position);
      // The bright disk occupies one quarter of the sprite's texture width.
      disk.scale.setScalar(8 * distance * Math.tan(angularDiameterRad * 0.5));
      for (let i = 0; i < elements.length; i++) elements[i]!.size = FLARE_SIZES[i]! * pixelRatio;
    },
    dispose(): void {
      group.removeFromParent();
      material.dispose();
      diskTexture.dispose();
      flare.dispose(); // Also releases the flare texture and internal render targets.
      for (const flareMaterial of Array.isArray(flare.material) ? flare.material : [flare.material])
        flareMaterial.dispose();
      // LensflareMesh.Geometry is shared by the addon; leave it owned there.
    },
  };
}

/** Optional owned scene layer. GPU assets are allocated only when attached. */
export interface SunLayerOptions {
  /** Approximate angular disk size. Defaults to 0.533 degrees at Earth/Moon. */
  angularDiameterDegrees?: number;
}

export function createSunLayer(options: SunLayerOptions = {}) {
  const diameter = options.angularDiameterDegrees ?? THREE.MathUtils.radToDeg(SUN_DIAMETER_RAD);
  if (!Number.isFinite(diameter) || diameter <= 0 || diameter >= 180)
    throw new RangeError("Sun angular diameter must be between 0 and 180 degrees");
  let objects: ReturnType<typeof createSunObjects> | undefined;
  let context: GlobeContext | undefined;
  let flareEnabled = true;
  return {
    id: "sun",
    attach(next: GlobeContext) {
      context = next;
      objects = createSunObjects(THREE.MathUtils.degToRad(diameter));
      objects.setFlareEnabled(flareEnabled);
      next.scene.add(objects.group);
    },
    update(frame: GlobeFrame) {
      objects!.update(frame);
    },
    setFlareEnabled(enabled: boolean) {
      flareEnabled = enabled;
      objects?.setFlareEnabled(enabled);
      context?.requestRender();
    },
    dispose() {
      objects?.dispose();
      objects = undefined;
    },
  };
}
