import { Vector3 } from "three/webgpu";

// A globe's terrain direction is the surface normal: its latitude is geodetic, which is
// what imagery, heights and WGS84 positions use. Only where a direction lands changes.

const _normal = new Vector3(),
  _offset = new Vector3(),
  _sphere = new Vector3();

/** From the sphere point `radius * normal` to the ellipsoid point with that normal. */
export function ellipsoidOffset(
  normal: Vector3,
  radius: number,
  flattening: number,
  target: Vector3,
): Vector3 {
  const e2 = flattening * (2 - flattening);
  const y2 = normal.y * normal.y;
  const s = Math.sqrt(1 - e2 * y2);
  // 1 / s - 1, without cancelling.
  const k = (e2 * y2) / (s * (1 + s));
  return target.set(k * normal.x, (k - e2 / s) * normal.y, k * normal.z).multiplyScalar(radius);
}

/**
 * The point on the reference sphere's matching normal line: same normal, same height.
 * Its direction is the geodetic normal and its length is radius + height.
 */
export function toSphere(
  point: Vector3,
  radius: number,
  flattening: number,
  target: Vector3,
): Vector3 {
  target.copy(point);
  if (flattening === 0) return target;
  // Each pass shrinks the error by about the flattening.
  for (let i = 0; i < 4; i++) {
    _normal.copy(target).normalize();
    target.copy(point).sub(ellipsoidOffset(_normal, radius, flattening, _offset));
  }
  return target;
}

/** Height of a point above the ellipsoid. */
export function altitudeOf(point: Vector3, radius: number, flattening: number): number {
  return toSphere(point, radius, flattening, _sphere).length() - radius;
}

const _origin = new Vector3(),
  _direction = new Vector3();

/** Distance along a unit-direction ray to a level `radius`, squashed at the poles. */
export function ellipsoidDistance(
  ray: { origin: Vector3; direction: Vector3 },
  radius: number,
  flattening: number,
  sphereDistance: (
    ray: { origin: Vector3; direction: Vector3 },
    radius: number,
  ) => number | undefined,
): number | undefined {
  // Stretching the poles out turns the ellipsoid into a sphere.
  const stretch = 1 / (1 - flattening);
  _origin.copy(ray.origin).setY(ray.origin.y * stretch);
  _direction.copy(ray.direction).setY(ray.direction.y * stretch);
  const length = _direction.length();
  _direction.divideScalar(length);
  const distance = sphereDistance({ origin: _origin, direction: _direction }, radius);
  return distance === undefined ? undefined : distance / length;
}
