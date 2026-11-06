import * as THREE from "three/webgpu";
import { createOrbitInput } from "./controls.ts";
import type { TiledGlobe } from "./tiled-globe.ts";

interface GlobeControlsEventMap {
  /** The camera moved; render again. */
  change: object;
}

const _direction = new THREE.Vector3(),
  _normal = new THREE.Vector3();

/**
 * Orbit, zoom and look around a globe, staying above its terrain.
 *
 * Like OrbitControls: construct with the camera and the element that receives
 * input, call `update()` each frame before `globe.update()`, and listen for
 * `change` to render on demand. The camera is attached to the globe (keeping its
 * world transform), so it rides along when the globe moves. Near and far planes
 * follow the altitude.
 *
 * Left drag orbits, right drag or Shift-drag looks around, and the wheel and pinch zoom
 * toward the cursor.
 */
export class GlobeControls extends THREE.EventDispatcher<GlobeControlsEventMap> {
  /** The camera being moved. */
  readonly camera: THREE.PerspectiveCamera;
  /** The element receiving input. */
  readonly domElement: HTMLElement;
  /** The globe being orbited. */
  readonly globe: TiledGlobe;
  /** Closest approach to the terrain, in meters. */
  minAltitude: number;
  #input: ReturnType<typeof createOrbitInput>;
  #ground?: { direction: THREE.Vector3; height: number };

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    globe: TiledGlobe,
    { minAltitude = 10 }: { minAltitude?: number } = {},
  ) {
    super();
    if (!Number.isFinite(minAltitude) || minAltitude <= 0)
      throw new RangeError("Invalid minimum altitude");
    this.camera = camera;
    this.domElement = domElement;
    this.globe = globe;
    this.minAltitude = minAltitude;
    if (camera.parent !== globe) globe.attach(camera);
    if (camera.position.lengthSq() === 0) camera.position.set(globe.radius * 3, 0, 0);
    this.#input = createOrbitInput(
      domElement as HTMLCanvasElement,
      camera,
      globe.radius,
      minAltitude,
      () => this.#groundHeight(),
      () => this.dispatchEvent({ type: "change" }),
      globe.flattening,
    );
  }

  /** Altitude above the displayed terrain. */
  get altitude(): number {
    return this.globe.altitudeOf(this.camera.position) - this.#groundHeight();
  }
  set altitude(meters: number) {
    if (!Number.isFinite(meters) || meters < this.minAltitude)
      throw new RangeError("Invalid altitude");
    this.camera.position.setLength(this.camera.position.length() + meters - this.altitude);
    this.dispatchEvent({ type: "change" });
  }

  /** Look straight down at a geographic position. */
  goTo(latitudeDeg: number, longitudeDeg: number, altitude = 10_000): void {
    if (
      !Number.isFinite(latitudeDeg) ||
      Math.abs(latitudeDeg) > 90 ||
      !Number.isFinite(longitudeDeg) ||
      Math.abs(longitudeDeg) > 180 ||
      !Number.isFinite(altitude) ||
      altitude < this.minAltitude
    )
      throw new RangeError("Invalid location");
    this.globe.positionAt(latitudeDeg, longitudeDeg, altitude, this.camera.position);
    this.#input.reset();
    this.dispatchEvent({ type: "change" });
  }

  /** Apply terrain clearance, aim the camera and fit its near/far planes. */
  update(): void {
    const { camera, globe, minAltitude } = this;
    const radius = globe.radius;
    // Height under the camera can change without the camera moving: elevation
    // arrives or a finer tile fades in. Keep the altitude across that change.
    const ground = this.#groundHeight();
    _direction.copy(camera.position).normalize();
    if (this.#ground?.direction.equals(_direction) && this.#ground.height !== ground)
      camera.position.setLength(camera.position.length() + ground - this.#ground.height);
    if (this.altitude < minAltitude)
      camera.position.setLength(camera.position.length() + minAltitude - this.altitude);
    this.#input.aim();
    const altitude = this.altitude;
    camera.near = Math.max(0.1, Math.min(radius * 0.01, altitude * 0.02));
    // Only grow far: the scene may hold more than this globe.
    camera.far = Math.max(camera.far, camera.position.length() + radius * 2);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const height = this.#groundHeight();
    this.#ground = { direction: camera.position.clone().normalize(), height };
  }

  /** Remove input listeners. The camera stays where it is. */
  dispose(): void {
    this.#input.dispose();
  }

  #groundHeight(): number {
    return this.globe.heightAt(this.globe.normalAt(this.camera.position, _normal));
  }
}
