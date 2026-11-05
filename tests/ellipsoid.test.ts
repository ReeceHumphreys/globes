import assert from "node:assert/strict";
import test from "node:test";
import { Vector3 } from "three/webgpu";
import { sphereDistance } from "../src/orbit.ts";
import { altitudeOf, ellipsoidDistance, ellipsoidOffset, toSphere } from "../src/ellipsoid.ts";
import { geographicToDirection } from "../src/geographic.ts";

const a = 6378137,
  f = 1 / 298.257223563,
  b = a * (1 - f);
const surface = (latitude: number, longitude: number, height = 0) => {
  const normal = geographicToDirection(latitude, longitude);
  return ellipsoidOffset(normal, a, f, new Vector3()).addScaledVector(normal, a + height);
};

test("the surface matches WGS84 at the equator, the pole and a published point", () => {
  assert.ok(surface(0, 0).distanceTo(new Vector3(a, 0, 0)) < 1e-6);
  assert.ok(surface(90, 0).distanceTo(new Vector3(0, b, 0)) < 1e-6);
  // Geodetic to ECEF by the textbook formula, with this library's Y-up axes.
  const lat = (45 * Math.PI) / 180,
    e2 = f * (2 - f),
    n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const expected = new Vector3(
    (n + 1000) * Math.cos(lat),
    (n * (1 - e2) + 1000) * Math.sin(lat),
    0,
  );
  assert.ok(surface(45, 0, 1000).distanceTo(expected) < 1e-6);
});

test("a point's normal and height survive the round trip", () => {
  for (const [latitude, height] of [
    [0, 0],
    [28.6, 120_000],
    [-45, 400_000],
    [89, 35_786_000],
  ]) {
    const point = surface(latitude, 30, height);
    assert.ok(Math.abs(altitudeOf(point, a, f) - height) < 1e-3);
    const normal = toSphere(point, a, f, new Vector3()).normalize();
    assert.ok(normal.distanceTo(geographicToDirection(latitude, 30)) < 1e-9);
  }
});

test("a sphere is unchanged", () => {
  const point = new Vector3(1, 2, 3).multiplyScalar(1e6);
  assert.ok(toSphere(point, a, 0, new Vector3()).equals(point));
  assert.equal(ellipsoidOffset(new Vector3(0, 1, 0), a, 0, new Vector3()).length(), 0);
});

test("a ray from above the pole stops at the polar surface, not the equatorial radius", () => {
  const ray = { origin: new Vector3(0, b + 1000, 0), direction: new Vector3(0, -1, 0) };
  assert.ok(Math.abs(ellipsoidDistance(ray, a, f, sphereDistance)! - 1000) < 1e-3);
});
