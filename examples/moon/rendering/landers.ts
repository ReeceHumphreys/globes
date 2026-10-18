import * as THREE from "three/webgpu";
import { APOLLO_LANDING_SITES, placeDirection, type Place } from "../places.ts";
import { defaultSunDirection } from "tiled-globe";

// NASA: 23 ft 1 in, legs extended. Any Y-up GLB works; it is rescaled to this height.
// https://www.nasa.gov/wp-content/uploads/static/history/Apollo204/spacecraft.html
export const LM_HEIGHT_M = 7.0358;
/** Optional, not bundled. Place a Y-up (optionally Draco-compressed) GLB here to show landers. */
export const LANDER_MODEL_PATH = "data/Apollo Lunar Module.glb";
const LOAD_DISTANCE_M = 30000;

export function normalizeLander(model: THREE.Object3D): THREE.Group {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const height = box.max.y - box.min.y;
  if (!(height > 0) || !Number.isFinite(height)) throw new Error("Invalid lunar module bounds");
  const scale = LM_HEIGHT_M / height;
  const centered = new THREE.Group();
  centered.add(model);
  // Feet at local y=0; horizontal center at the landing coordinates.
  centered.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const root = new THREE.Group();
  root.scale.setScalar(scale);
  root.add(centered);
  return root;
}

// Local +X=east, +Y=radial up, +Z=south. Historical yaw/tilt is not reconstructed.
export function landerOrientation(place: Place): THREE.Quaternion {
  const up = new THREE.Vector3(...placeDirection(place));
  const lon = THREE.MathUtils.degToRad(place.longitudeDeg);
  const east = new THREE.Vector3(-Math.sin(lon), 0, -Math.cos(lon));
  const south = new THREE.Vector3().crossVectors(east, up);
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(east, up, south),
  );
}

function release(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

export function createLanderLayer(baseURL: string, redraw: () => void, ownLighting = true) {
  const group = new THREE.Group();
  group.name = "Apollo lunar modules (camera relative)";
  const sun = ownLighting ? new THREE.DirectionalLight(0xffffff, 3) : undefined;
  const ambient = ownLighting ? new THREE.AmbientLight(0xffffff, 0.08) : undefined;
  if (sun && ambient) {
    sun.position.set(...defaultSunDirection());
    group.add(sun, sun.target, ambient);
  }
  const sites = APOLLO_LANDING_SITES.map((place) => ({
    place,
    up: new THREE.Vector3(...placeDirection(place)),
  }));
  const models: THREE.Object3D[] = [];
  const offset = new THREE.Vector3();
  let disposed = false;
  let loading = false;
  let template: THREE.Object3D | undefined;
  let decoder: { dispose(): void } | undefined;

  async function load(): Promise<void> {
    loading = true;
    try {
      // The model is optional and not bundled; skip quietly when it is absent.
      // Vite's SPA fallback answers a missing file with index.html, so check the type too.
      const modelURL = new URL(LANDER_MODEL_PATH, baseURL).href;
      const response = await fetch(modelURL).catch(() => undefined);
      if (disposed) return;
      if (!response?.ok || response.headers.get("content-type")?.includes("text/html")) {
        console.info(`[Globes] No lunar module model at ${LANDER_MODEL_PATH}; skipping landers`);
        return;
      }
      const glb = await response.arrayBuffer();
      if (disposed) return;
      const [{ GLTFLoader }, { DRACOLoader }, { mergeGeometries }] = await Promise.all([
        import("three/addons/loaders/GLTFLoader.js"),
        import("three/addons/loaders/DRACOLoader.js"),
        import("three/addons/utils/BufferGeometryUtils.js"),
      ]);
      if (disposed) return;
      const draco = new DRACOLoader().setDecoderPath({
        js: new URL("data/draco/draco_wasm_wrapper.js", baseURL).href,
        wasm: new URL("data/draco/draco_decoder.wasm", baseURL).href,
      });
      decoder = draco;
      const gltf = await new GLTFLoader()
        .setDRACOLoader(draco)
        .parseAsync(glb, new URL(".", modelURL).href);
      if (disposed) {
        release(gltf.scene);
        return;
      }
      // Flatten static meshes by material: 134 source objects become ~12 draws per visible LM.
      gltf.scene.updateMatrixWorld(true);
      const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
      const originals = new Set<THREE.BufferGeometry>();
      gltf.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        if (Array.isArray(object.material))
          throw new Error("Expected one material per GLB primitive");
        const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
        // A few untextured primitives omit UVs; give every batch the same layout.
        if (!geometry.hasAttribute("uv"))
          geometry.setAttribute(
            "uv",
            new THREE.BufferAttribute(
              new Float32Array(geometry.getAttribute("position").count * 2),
              2,
            ),
          );
        const list = batches.get(object.material) ?? [];
        list.push(geometry);
        batches.set(object.material, list);
        originals.add(object.geometry);
      });
      const merged = new THREE.Group();
      for (const [material, geometries] of batches) {
        const geometry = mergeGeometries(geometries);
        if (!geometry) throw new Error("Could not batch lunar module geometry");
        merged.add(new THREE.Mesh(geometry, material));
        for (const source of geometries) source.dispose();
      }
      for (const geometry of originals) geometry.dispose();
      template = normalizeLander(merged);
      for (const { place } of sites) {
        const root = new THREE.Group();
        root.name = `${place.name} LM`;
        root.quaternion.copy(landerOrientation(place));
        root.add(template.clone(true)); // geometry, materials and textures remain shared.
        root.visible = false;
        models.push(root);
        group.add(root);
      }
      console.info("[Globes] Lunar modules ready", {
        heightMeters: LM_HEIGHT_M,
        sites: models.length,
        materialBatches: batches.size,
      });
      redraw();
    } catch (error) {
      if (!disposed) console.error("[Globes] Lunar module failed to load", error);
    } finally {
      decoder?.dispose();
      decoder = undefined;
    }
  }

  return {
    group,
    setSun(x: number, y: number, z: number) {
      sun?.position.set(x, y, z).normalize();
    },
    update(
      camera: THREE.PerspectiveCamera,
      radius: number,
      height: (x: number, y: number, z: number) => number,
    ) {
      // Cancel camera translation in float64 on CPU, before GPU transforms.
      group.position.copy(camera.position);
      let close = false;
      for (let i = 0; i < sites.length; i++) {
        const { up } = sites[i];
        offset
          .copy(up)
          .multiplyScalar(radius + height(up.x, up.y, up.z))
          .sub(camera.position);
        const visible =
          offset.lengthSq() < LOAD_DISTANCE_M ** 2 && up.dot(camera.position) > radius - 15000;
        close ||= visible;
        if (models[i]) {
          models[i].position.copy(offset);
          models[i].visible = visible;
        }
      }
      if (close && !loading && !disposed) void load();
    },
    dispose() {
      disposed = true;
      decoder?.dispose();
      if (template) release(template);
      sun?.dispose();
      ambient?.dispose();
      group.clear();
      group.removeFromParent();
    },
  };
}
