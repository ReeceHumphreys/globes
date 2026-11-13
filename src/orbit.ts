import { MathUtils, Matrix4, Quaternion, Vector3, type PerspectiveCamera } from "three/webgpu";

const _anchorTurn = new Quaternion();
const _look = new Matrix4();

/**
 * Orbit math runs in the camera's parent frame, which is the globe's. Object3D.lookAt
 * takes world space, so aim with the local position, target and up instead.
 */
export function lookAtLocal(camera: PerspectiveCamera, target: Vector3): void {
  _look.lookAt(camera.position, target, camera.up);
  camera.quaternion.setFromRotationMatrix(_look);
}
const _origin = new Vector3();

/** Rotate the camera so the newly picked ground moves beneath the original anchor. */
export function anchorOrbit(camera: PerspectiveCamera, current: Vector3, anchor: Vector3): void {
  _anchorTurn.setFromUnitVectors(current, anchor);
  camera.position.applyQuaternion(_anchorTurn);
  camera.up.applyQuaternion(_anchorTurn);
}

const _radial = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _turn = new Quaternion();
const _pitch = new Quaternion();

// World north is parallel to the view at either pole, so a Y-up orbit twists there.
// Keep the stored up vector tangent to the position and carry it with the drag.
function orientUp(camera: PerspectiveCamera): void {
  _radial.copy(camera.position).normalize();
  _up.copy(camera.up).addScaledVector(_radial, -camera.up.dot(_radial));
  if (_up.lengthSq() < 1e-16) {
    _up.set(0, 1, 0).addScaledVector(_radial, -_radial.y);
    if (_up.lengthSq() < 1e-16) _up.set(0, 0, 1).addScaledVector(_radial, -_radial.z);
  }
  camera.up.copy(_up.normalize());
}

// Angle from straight down to the horizon. Past this, the view leaves the surface.
export function horizonTilt(distance: number, radius: number): number {
  return Math.asin(Math.min(1, radius / Math.max(distance, radius)));
}

// A full screen of drag covers the ground span of the vertical field of view,
// and never spins faster than one turn.
export function orbitRotateSpeed(altitude: number, radius: number, fovDegrees: number): number {
  const half = MathUtils.degToRad(fovDegrees) / 2;
  return Math.min(1, (Math.max(altitude, 0) * Math.tan(half)) / (Math.PI * radius));
}

// Yaw, then pitch. Positive heading turns toward screen-right; positive tilt pitches toward the horizon.
export function aimAtOrigin(camera: PerspectiveCamera, tilt: number, heading = 0): void {
  if (camera.position.lengthSq() === 0) return;
  orientUp(camera);
  lookAtLocal(camera, _origin.set(0, 0, 0));
  camera.rotateZ(-heading);
  camera.rotateX(tilt);
}

// Screen-space orbit around the origin. Positive yaw is a rightward drag (camera
// moves screen-left). Positive pitch is a downward drag (camera moves screen-up).
export function orbitAroundOrigin(camera: PerspectiveCamera, yaw: number, pitch: number): void {
  if (camera.position.lengthSq() === 0 || (yaw === 0 && pitch === 0)) return;
  orientUp(camera);
  _radial.copy(camera.position).normalize();
  _right.crossVectors(camera.up, _radial).normalize();
  _turn.setFromAxisAngle(camera.up, -yaw);
  _pitch.setFromAxisAngle(_right, -pitch);
  _turn.multiply(_pitch);
  camera.position.applyQuaternion(_turn);
  camera.up.applyQuaternion(_turn);
  orientUp(camera);
}
