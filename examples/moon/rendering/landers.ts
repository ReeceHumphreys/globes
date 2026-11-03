import * as THREE from "three/webgpu";
import { APOLLO_LANDING_SITES, placeDirection, type Place } from "../places.ts";
import type { TiledGlobe } from "tiled-globe";

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

const _camera = new THREE.Vector3(),
  _offset = new THREE.Vector3();

/**
 * Apollo lunar modules at their landing sites, loaded the first time the camera comes
 * within 30 km. Add to the Moon globe and call `update` each frame. Lit by the scene.
 */
export class ApolloLanders extends THREE.Group {
  readonly #baseURL: string;
  readonly #sites = APOLLO_LANDING_SITES.map((place) => ({
    place,
    up: new THREE.Vector3(...placeDirection(place)),
  }));
  readonly #models: THREE.Object3D[] = [];
  #loading = false;
  #disposed = false;
  #template?: THREE.Object3D;

  constructor(baseURL: string) {
    super();
    this.name = "Apollo lunar modules (camera relative)";
    this.#baseURL = baseURL;
  }

  update(camera: THREE.PerspectiveCamera, globe: TiledGlobe): void {
    globe.worldToLocal(camera.getWorldPosition(_camera));
    // Cancel camera translation in float64 on CPU, before GPU transforms.
    this.position.copy(_camera);
    let close = false;
    this.#sites.forEach(({ up }, i) => {
      _offset
        .copy(up)
        .multiplyScalar(globe.radius + globe.heightAt(up))
        .sub(_camera);
      const visible =
        _offset.lengthSq() < LOAD_DISTANCE_M ** 2 && up.dot(_camera) > globe.radius - 15000;
      close ||= visible;
      const model = this.#models[i];
      if (model) {
        model.position.copy(_offset);
        model.visible = visible;
      }
    });
    if (close && !this.#loading && !this.#disposed) void this.#load();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#template) release(this.#template);
    this.clear();
    this.removeFromParent();
  }

  async #load(): Promise<void> {
    this.#loading = true;
    let decoder: { dispose(): void } | undefined;
    try {
      // The model is optional and not bundled; skip quietly when it is absent.
      // Vite's SPA fallback answers a missing file with index.html, so check the type too.
      const modelURL = new URL(LANDER_MODEL_PATH, this.#baseURL).href;
      const response = await fetch(modelURL).catch(() => undefined);
      if (this.#disposed) return;
      if (!response?.ok || response.headers.get("content-type")?.includes("text/html")) {
        console.info(`[Globes] No lunar module model at ${LANDER_MODEL_PATH}; skipping landers`);
        return;
      }
      const glb = await response.arrayBuffer();
      if (this.#disposed) return;
      const [{ GLTFLoader }, { DRACOLoader }, { mergeGeometries }] = await Promise.all([
        import("three/addons/loaders/GLTFLoader.js"),
        import("three/addons/loaders/DRACOLoader.js"),
        import("three/addons/utils/BufferGeometryUtils.js"),
      ]);
      if (this.#disposed) return;
      const draco = new DRACOLoader().setDecoderPath({
        js: new URL("data/draco/draco_wasm_wrapper.js", this.#baseURL).href,
        wasm: new URL("data/draco/draco_decoder.wasm", this.#baseURL).href,
      });
      decoder = draco;
      const gltf = await new GLTFLoader()
        .setDRACOLoader(draco)
        .parseAsync(glb, new URL(".", modelURL).href);
      if (this.#disposed) {
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
      const template = (this.#template = normalizeLander(merged));
      for (const { place } of this.#sites) {
        const root = new THREE.Group();
        root.name = `${place.name} LM`;
        root.quaternion.copy(landerOrientation(place));
        root.add(template.clone(true)); // geometry, materials and textures remain shared.
        root.visible = false;
        this.#models.push(root);
        this.add(root);
      }
    } catch (error) {
      if (!this.#disposed) console.error("[Globes] Lunar module failed to load", error);
    } finally {
      decoder?.dispose();
    }
  }
}
