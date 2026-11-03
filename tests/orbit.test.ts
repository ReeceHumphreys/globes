import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "three/webgpu";
const MOON_RADIUS_M = 1_737_400;
import { aimAtOrigin, horizonTilt, orbitAroundOrigin, orbitRotateSpeed } from "../src/orbit.ts";

test("positive tilt pitches from nadir toward world up", () => {
  const camera = new PerspectiveCamera(75, 1.5, 0.1, 1e7);
  const direction = new Vector3();
  for (const position of [
    [0, 0, MOON_RADIUS_M + 10],
    [MOON_RADIUS_M * 3, 0, 0],
  ] as const) {
    camera.up.set(0, 1, 0);
    camera.position.set(position[0], position[1], position[2]);
    const before = camera.position.clone();
    aimAtOrigin(camera, 0);
    camera.getWorldDirection(direction);
    const nadir = before.clone().normalize().negate();
    assert.ok(direction.angleTo(nadir) < 1e-6);
    aimAtOrigin(camera, 0.4);
    camera.getWorldDirection(direction);
    assert.ok(Math.abs(direction.angleTo(nadir) - 0.4) < 1e-6);
    assert.ok(direction.y > 0);
    assert.deepEqual(camera.position.toArray(), before.toArray());
  }
});

test("positive heading turns the tilted gaze toward screen-right", () => {
  const camera = new PerspectiveCamera(75, 1.5, 0.1, 1e7);
  const basis = new PerspectiveCamera(75, 1.5, 0.1, 1e7);
  const direction = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  for (const position of [
    [0, 0, MOON_RADIUS_M + 10],
    [MOON_RADIUS_M * 3, 0, 0],
  ] as const) {
    basis.up.set(0, 1, 0);
    basis.position.set(position[0], position[1], position[2]);
    basis.lookAt(0, 0, 0);
    basis.updateMatrixWorld();
    right.setFromMatrixColumn(basis.matrixWorld, 0);
    up.setFromMatrixColumn(basis.matrixWorld, 1);
    camera.up.set(0, 1, 0);
    camera.position.set(position[0], position[1], position[2]);
    aimAtOrigin(camera, 0.4, Math.PI / 2);
    camera.getWorldDirection(direction);
    const nadir = camera.position.clone().normalize().negate();
    assert.ok(Math.abs(direction.angleTo(nadir) - 0.4) < 1e-6);
    assert.ok(direction.dot(right) > 0.3);
    assert.ok(Math.abs(direction.dot(up)) < 0.05);
  }
});

test("orbit drag grabs the surface and does not roll across the south pole", () => {
  const camera = new PerspectiveCamera(75, 1.5, 0.1, 1e7);
  const screenUp = new Vector3();
  const previousUp = new Vector3();

  camera.up.set(0, 1, 0);
  camera.position.set(MOON_RADIUS_M, 0, 0);
  orbitAroundOrigin(camera, 0.05, 0);
  assert.ok(camera.position.z > 0);
  assert.ok(Math.abs(camera.position.length() - MOON_RADIUS_M) < 1e-4);

  camera.up.set(0, 1, 0);
  camera.position.set(0, 0, MOON_RADIUS_M);
  orbitAroundOrigin(camera, 0.05, 0);
  assert.ok(camera.position.x < 0);

  camera.up.set(0, 1, 0);
  camera.position.set(MOON_RADIUS_M, 0, 0);
  orbitAroundOrigin(camera, 0, 0.05);
  assert.ok(camera.position.y > 0);

  const latitude = (-80 * Math.PI) / 180;
  camera.up.set(0, 1, 0);
  camera.position.set(Math.cos(latitude) * MOON_RADIUS_M, Math.sin(latitude) * MOON_RADIUS_M, 0);
  aimAtOrigin(camera, 0);
  camera.updateMatrixWorld(true);
  previousUp.setFromMatrixColumn(camera.matrixWorld, 1);
  for (let step = 0; step < 20; step++) {
    orbitAroundOrigin(camera, 0, (-2 * Math.PI) / 180);
    aimAtOrigin(camera, 0);
    camera.updateMatrixWorld(true);
    screenUp.setFromMatrixColumn(camera.matrixWorld, 1);
    assert.ok(screenUp.dot(previousUp) > 0.95, `view rolled at step ${step}`);
    assert.ok(Math.abs(camera.up.dot(camera.position.clone().normalize())) < 1e-6);
    previousUp.copy(screenUp);
  }
  assert.ok(camera.position.x < 0);
  assert.ok(camera.position.y < 0);

  camera.up.set(0, 1, 0);
  camera.position.set(0, -MOON_RADIUS_M, 0);
  aimAtOrigin(camera, 0);
  camera.updateMatrixWorld(true);
  const direction = new Vector3();
  camera.getWorldDirection(direction);
  assert.ok(direction.angleTo(new Vector3(0, 1, 0)) < 1e-4);
  screenUp.setFromMatrixColumn(camera.matrixWorld, 1);
  const again = screenUp.clone();
  aimAtOrigin(camera, 0);
  camera.updateMatrixWorld(true);
  screenUp.setFromMatrixColumn(camera.matrixWorld, 1);
  assert.ok(screenUp.dot(again) > 0.999);
});

test("orbit drag matches the visible ground, and tilt stops at the horizon", () => {
  const altitude = 10;
  const speed = orbitRotateSpeed(altitude, MOON_RADIUS_M, 75);
  const groundArc = MOON_RADIUS_M * 2 * Math.PI * speed;
  const visible = 2 * altitude * Math.tan((75 * Math.PI) / 180 / 2);
  assert.ok(Math.abs(groundArc - visible) < 1e-6);
  assert.equal(orbitRotateSpeed(MOON_RADIUS_M * 9, MOON_RADIUS_M, 75), 1);
  assert.ok(horizonTilt(MOON_RADIUS_M + altitude, MOON_RADIUS_M) > 1.5);
  assert.ok(Math.abs(horizonTilt(MOON_RADIUS_M * 3, MOON_RADIUS_M) - Math.asin(1 / 3)) < 1e-12);
});

test("surface anchoring preserves the picked location across bodies, poles, and zoom", async () => {
  const { pickGlobe, anchorOrbit } = await import("../src/orbit.ts");
  for (const radius of [1737400, 3396190, 6378137]) {
    for (const altitude of [10, radius * 2]) {
      const camera = new PerspectiveCamera(60, 1.5, 0.1, radius * 20);
      camera.position.set(0, -(radius + altitude), 0);
      camera.up.set(0, 0, 1);
      aimAtOrigin(camera, 0);
      const anchor = new Vector3(),
        hit = new Vector3(),
        after = new Vector3();
      assert.ok(pickGlobe(camera, 0, 0, radius, anchor));
      assert.ok(pickGlobe(camera, 0.08, 0.04, radius, hit));
      const distance = camera.position.length();
      anchorOrbit(camera, hit, anchor);
      aimAtOrigin(camera, 0);
      assert.ok(pickGlobe(camera, 0.08, 0.04, radius, after));
      assert.ok(after.distanceTo(anchor) < 1e-8);
      assert.ok(Math.abs(camera.position.length() - distance) < 1e-6);
      camera.position.setLength(radius + altitude * 0.5);
      aimAtOrigin(camera, 0);
      assert.ok(pickGlobe(camera, 0.08, 0.04, radius, hit));
      anchorOrbit(camera, hit, anchor);
      aimAtOrigin(camera, 0);
      assert.ok(pickGlobe(camera, 0.08, 0.04, radius, after));
      assert.ok(after.distanceTo(anchor) < 1e-8);
    }
  }
});

test("globe picking rejects space and rays looking away from the body", async () => {
  const { pickGlobe } = await import("../src/orbit.ts");
  const camera = new PerspectiveCamera(75, 1.5, 0.1, 1e8);
  camera.position.set(0, 0, 6378137 * 3);
  camera.lookAt(0, 0, 0);
  assert.equal(pickGlobe(camera, 1, 1, 6378137, new Vector3()), false);
  camera.lookAt(0, 0, 1e8);
  assert.equal(pickGlobe(camera, 0, 0, 6378137, new Vector3()), false);
});
