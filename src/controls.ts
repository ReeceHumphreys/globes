import * as THREE from "three/webgpu";
import {
  aimAtOrigin,
  anchorOrbit,
  horizonTilt,
  orbitAroundOrigin,
  orbitRotateSpeed,
  pickGlobe,
} from "./orbit.ts";

/** A moving point the camera orbits instead of the body center, such as a spacecraft. */
export interface CameraFocus {
  /** Writes the point to orbit, in scene meters, for the frame being rendered. */
  target(out: THREE.Vector3): void;
  /** Initial camera distance from the target. Defaults to 30 m. */
  distanceMeters?: number;
  minDistanceMeters?: number;
  maxDistanceMeters?: number;
}

const _focusTarget = new THREE.Vector3(),
  _focusUp = new THREE.Vector3(),
  _focusNorth = new THREE.Vector3(),
  _focusEast = new THREE.Vector3();

// Input owns the camera only. Selection and rendering remain demand-driven in the engine.
export function createOrbitInput(
  canvas: HTMLCanvasElement,
  camera: THREE.PerspectiveCamera,
  radius: number,
  minAltitude: number,
  groundHeight: () => number,
  render: () => void,
) {
  let tilt = 0,
    heading = 0;
  const pointers = new Map<number, { x: number; y: number; look: boolean }>();
  const anchor = new THREE.Vector3(),
    hit = new THREE.Vector3();
  let anchored = false,
    pinchDistance = 0;
  // Focus orbit: spherical offset in the target's local frame (up is radial, azimuth from north).
  let focus: Required<CameraFocus> | undefined,
    focusAzimuth = 0,
    focusElevation = 0.3;
  const oldTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";
  const height = () => Math.max(1, canvas.clientHeight);
  const altitude = () => Math.max(minAltitude, camera.position.length() - radius - groundHeight());
  function aim() {
    tilt = THREE.MathUtils.clamp(tilt, 0, horizonTilt(camera.position.length(), radius));
    aimAtOrigin(camera, tilt, heading);
  }
  function pick(x: number, y: number, output: THREE.Vector3) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return pickGlobe(
      camera,
      ((x - rect.left) / rect.width) * 2 - 1,
      1 - ((y - rect.top) / rect.height) * 2,
      radius + groundHeight(),
      output,
    );
  }
  function beginAnchor(x: number, y: number) {
    aim();
    anchored = pick(x, y, anchor);
  }
  function aimFocus() {
    if (!focus) return;
    focus.target(_focusTarget);
    _focusUp.copy(_focusTarget).normalize();
    if (_focusUp.lengthSq() === 0) _focusUp.set(0, 1, 0);
    _focusNorth.set(0, 1, 0).addScaledVector(_focusUp, -_focusUp.y);
    if (_focusNorth.lengthSq() < 1e-12)
      _focusNorth.set(1, 0, 0).addScaledVector(_focusUp, -_focusUp.x);
    _focusNorth.normalize();
    _focusEast.crossVectors(_focusNorth, _focusUp);
    const flat = Math.cos(focusElevation) * focus.distanceMeters;
    camera.position
      .copy(_focusTarget)
      .addScaledVector(_focusUp, Math.sin(focusElevation) * focus.distanceMeters)
      .addScaledVector(_focusNorth, -Math.cos(focusAzimuth) * flat)
      .addScaledVector(_focusEast, -Math.sin(focusAzimuth) * flat);
    camera.up.copy(_focusUp);
    camera.lookAt(_focusTarget);
  }
  function zoomFocus(factor: number) {
    focus!.distanceMeters = THREE.MathUtils.clamp(
      focus!.distanceMeters * factor,
      focus!.minDistanceMeters,
      focus!.maxDistanceMeters,
    );
    render();
  }
  function zoomAt(factor: number, x: number, y: number) {
    if (focus) return zoomFocus(factor);
    aim();
    const hasAnchor = pick(x, y, anchor);
    const ground = groundHeight();
    camera.position.setLength(
      radius + ground + THREE.MathUtils.clamp(altitude() * factor, minAltitude, radius * 9),
    );
    aim();
    if (hasAnchor && pick(x, y, hit)) anchorOrbit(camera, hit, anchor);
    // Terrain can be higher beneath the destination; never carry the old clearance there.
    camera.position.setLength(
      Math.max(camera.position.length(), radius + groundHeight() + minAltitude),
    );
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
    if (focus) {
      const angle = (2 * Math.PI) / height();
      focusAzimuth = THREE.MathUtils.euclideanModulo(focusAzimuth - dx * angle, Math.PI * 2);
      focusElevation = THREE.MathUtils.clamp(focusElevation + dy * angle, -1.5, 1.5);
      render();
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
        const turn = (2 * Math.PI * orbitRotateSpeed(altitude(), radius, camera.fov)) / height();
        orbitAroundOrigin(camera, dx * turn, dy * turn);
        aim();
        anchored = pick(event.clientX, event.clientY, anchor);
      }
      camera.position.setLength(
        Math.max(camera.position.length(), radius + groundHeight() + minAltitude),
      );
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
    aim() {
      if (focus) aimFocus();
      else aim();
    },
    /** Camera distance from the focus target, or undefined when orbiting the body. */
    get focusDistance() {
      return focus?.distanceMeters;
    },
    setFocusDistance(meters: number) {
      if (!focus) return;
      focus.distanceMeters = THREE.MathUtils.clamp(
        meters,
        focus.minDistanceMeters,
        focus.maxDistanceMeters,
      );
    },
    setFocus(next: CameraFocus | null) {
      if (!next) {
        focus = undefined;
        camera.up.set(0, 1, 0);
        tilt = heading = 0;
        return;
      }
      const distanceMeters = next.distanceMeters ?? 30,
        minDistanceMeters = next.minDistanceMeters ?? 1,
        maxDistanceMeters = next.maxDistanceMeters ?? radius * 9;
      if (
        !(minDistanceMeters > 0) ||
        !(maxDistanceMeters >= minDistanceMeters) ||
        !(distanceMeters >= minDistanceMeters && distanceMeters <= maxDistanceMeters)
      )
        throw new RangeError("Invalid camera focus distances");
      focus = { target: next.target, distanceMeters, minDistanceMeters, maxDistanceMeters };
      focusAzimuth = 0;
      focusElevation = 0.3;
    },
    reset() {
      tilt = 0;
      heading = 0;
      anchored = false;
      const captured = [...pointers.keys()];
      pointers.clear();
      for (const id of captured) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      pinchDistance = 0;
      focus = undefined;
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
