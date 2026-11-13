import * as THREE from "three/webgpu";
import {
  aimAtOrigin,
  anchorOrbit,
  horizonTilt,
  orbitAroundOrigin,
  orbitRotateSpeed,
} from "./orbit.ts";
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
    this.#input = createOrbitInput(domElement as HTMLCanvasElement, camera, globe, {
      altitude: () => this.altitude,
      setAltitude: (meters) => this.#setAltitude(meters),
      keepClear: () => this.#keepClear(),
      minAltitude: () => this.minAltitude,
      render: () => this.dispatchEvent({ type: "change" }),
    });
  }

  /** Altitude above the displayed terrain. */
  get altitude(): number {
    return this.globe.altitudeOf(this.camera.position) - this.#groundHeight();
  }
  set altitude(meters: number) {
    if (!Number.isFinite(meters) || meters < this.minAltitude)
      throw new RangeError("Invalid altitude");
    this.#setAltitude(meters);
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
    const { camera, globe } = this;
    const radius = globe.radius;
    // Height under the camera can change without the camera moving: elevation
    // arrives or a finer tile fades in. Keep the altitude across that change.
    const ground = this.#groundHeight();
    _direction.copy(camera.position).normalize();
    if (this.#ground?.direction.equals(_direction) && this.#ground.height !== ground)
      camera.position.setLength(camera.position.length() + ground - this.#ground.height);
    this.#keepClear();
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

  // Radial moves change height by the same amount, to within the flattening.
  #setAltitude(meters: number): void {
    this.camera.position.setLength(this.camera.position.length() + meters - this.altitude);
  }

  #keepClear(): void {
    if (this.altitude < this.minAltitude) this.#setAltitude(this.minAltitude);
  }

  #groundHeight(): number {
    return this.globe.heightAt(this.globe.normalAt(this.camera.position, _normal));
  }
}

const _ndc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _picked: THREE.Intersection[] = [];

// What the pointer input needs from GlobeControls: the one clearance rule lives there.
interface Clearance {
  altitude(): number;
  setAltitude(meters: number): void;
  keepClear(): void;
  minAltitude(): number;
  render(): void;
}

// Input owns the camera only. Selection and rendering remain demand-driven in the engine.
function createOrbitInput(
  canvas: HTMLCanvasElement,
  camera: THREE.PerspectiveCamera,
  globe: TiledGlobe,
  { altitude: above, setAltitude, keepClear, minAltitude, render }: Clearance,
) {
  let tilt = 0,
    heading = 0;
  const pointers = new Map<number, { x: number; y: number; look: boolean }>();
  const anchor = new THREE.Vector3(),
    hit = new THREE.Vector3();
  let anchored = false,
    pinchDistance = 0;
  const oldTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";
  const height = () => Math.max(1, canvas.clientHeight);
  const altitude = () => Math.max(minAltitude(), above());
  function aim() {
    const distance = camera.position.length();
    tilt = THREE.MathUtils.clamp(
      tilt,
      0,
      horizonTilt(distance, distance - globe.altitudeOf(camera.position)),
    );
    aimAtOrigin(camera, tilt, heading);
  }
  function pick(x: number, y: number, output: THREE.Vector3) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    _ndc.set(((x - rect.left) / rect.width) * 2 - 1, 1 - ((y - rect.top) / rect.height) * 2);
    camera.updateWorldMatrix(true, false);
    _raycaster.setFromCamera(_ndc, camera);
    // Rendering's far plane can sit in front of the planet; a miss here spins instead of grabbing.
    _raycaster.far = Infinity;
    _picked.length = 0;
    globe.raycast(_raycaster, _picked);
    const found = _picked[0];
    if (!found) return false;
    output.copy(found.point);
    // anchorOrbit consumes a unit direction in the camera's parent, the globe's local frame.
    if (camera.parent) camera.parent.worldToLocal(output);
    output.normalize();
    return output.lengthSq() > 0;
  }
  function beginAnchor(x: number, y: number) {
    aim();
    anchored = pick(x, y, anchor);
  }
  function zoomAt(factor: number, x: number, y: number) {
    aim();
    const hasAnchor = pick(x, y, anchor);
    setAltitude(THREE.MathUtils.clamp(altitude() * factor, minAltitude(), globe.radius * 9));
    aim();
    if (hasAnchor && pick(x, y, hit)) anchorOrbit(camera, hit, anchor);
    // Terrain can be higher beneath the destination; never carry the old clearance there.
    keepClear();
    render();
  }
  function pointerDown(event: PointerEvent) {
    if (event.button !== 0 && event.button !== 2) return;
    if (pointers.size >= 2) return;
    const look = event.button === 2 || event.shiftKey;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, look });
    canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 1 && !look) beginAnchor(event.clientX, event.clientY);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      anchored = false;
    }
    event.preventDefault();
  }
  function pointerMove(event: PointerEvent) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const dx = event.clientX - previous.x,
      dy = event.clientY - previous.y;
    previous.x = event.clientX;
    previous.y = event.clientY;
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0 && distance > 0)
        zoomAt(
          THREE.MathUtils.clamp(pinchDistance / distance, 0.5, 2),
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
        );
      pinchDistance = distance;
      return;
    }
    if (previous.look) {
      const angle = THREE.MathUtils.degToRad(camera.fov) / height();
      tilt -= dy * angle;
      heading =
        THREE.MathUtils.euclideanModulo(heading + dx * angle + Math.PI, Math.PI * 2) - Math.PI;
    } else {
      aim();
      if (anchored && pick(event.clientX, event.clientY, hit)) {
        anchorOrbit(camera, hit, anchor);
      } else {
        // Outside the disc, keep rotating at a bounded altitude-dependent speed.
        const turn =
          (2 * Math.PI * orbitRotateSpeed(altitude(), globe.radius, camera.fov)) / height();
        orbitAroundOrigin(camera, dx * turn, dy * turn);
        aim();
        anchored = pick(event.clientX, event.clientY, anchor);
      }
      keepClear();
    }
    render();
  }
  function pointerUp(event: PointerEvent) {
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    pinchDistance = 0;
    anchored = false;
    if (pointers.size === 1) {
      const [remaining] = pointers.values();
      if (!remaining.look) beginAnchor(remaining.x, remaining.y);
    }
  }
  function lostCapture(event: PointerEvent) {
    // A normal release has already removed this pointer.
    if (pointers.has(event.pointerId)) pointerUp(event);
  }
  function zoom(event: WheelEvent) {
    event.preventDefault();
    const delta =
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height() : 1);
    zoomAt(Math.exp(THREE.MathUtils.clamp(delta * 0.002, -2, 2)), event.clientX, event.clientY);
    if (pointers.size === 1) {
      const [pointer] = pointers.values();
      if (!pointer.look) beginAnchor(pointer.x, pointer.y);
    }
  }
  function doubleClick(event: MouseEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    zoomAt(event.shiftKey ? 2 : 0.5, event.clientX, event.clientY);
  }
  const blockContextMenu = (event: Event) => event.preventDefault();
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("lostpointercapture", lostCapture);
  canvas.addEventListener("contextmenu", blockContextMenu);
  canvas.addEventListener("wheel", zoom, { passive: false });
  canvas.addEventListener("dblclick", doubleClick);
  return {
    aim,
    reset() {
      tilt = 0;
      heading = 0;
      anchored = false;
      const captured = [...pointers.keys()];
      pointers.clear();
      for (const id of captured) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      pinchDistance = 0;
      camera.up.set(0, 1, 0);
    },
    dispose() {
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("lostpointercapture", lostCapture);
      canvas.removeEventListener("contextmenu", blockContextMenu);
      canvas.removeEventListener("wheel", zoom);
      canvas.removeEventListener("dblclick", doubleClick);
      for (const id of pointers.keys())
        if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      pointers.clear();
      canvas.style.touchAction = oldTouchAction;
    },
  };
}
