import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3, WebGPUCoordinateSystem } from "three/webgpu";
import { MOON_RADIUS_M } from "../examples/moon/config.ts";
import { APOLLO_LANDING_SITES, projectPlace, type Place } from "../examples/moon/places.ts";
import { sunDirection } from "../src/rendering/sun.ts";

function cameraAtPlusX(): PerspectiveCamera {
  const camera = new PerspectiveCamera(75, 2, 1, MOON_RADIUS_M * 20);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  (camera as unknown as { _reversedDepth: boolean })._reversedDepth = true;
  camera.up.set(0, 1, 0);
  camera.position.set(MOON_RADIUS_M * 3, 0, 0);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

test("Apollo labels use the six landing sites and the globe's east axis", () => {
  assert.deepEqual(
    APOLLO_LANDING_SITES.map((place) => place.name),
    ["Apollo 11", "Apollo 12", "Apollo 14", "Apollo 15", "Apollo 16", "Apollo 17"],
  );
  const camera = cameraAtPlusX();
  const width = 200;
  const height = 100;
  const center = projectPlace(
    { name: "subcamera", latitudeDeg: 0, longitudeDeg: 0 },
    camera,
    MOON_RADIUS_M,
    width,
    height,
  );
  assert.ok(center.visible);
  assert.ok(Math.abs(center.x - width / 2) < 1);
  assert.ok(Math.abs(center.y - height / 2) < 1);

  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const eastDir = sunDirection((20 * Math.PI) / 180, 0);
  const northDir = sunDirection(0, (20 * Math.PI) / 180);
  const east = projectPlace(
    { name: "east", latitudeDeg: 0, longitudeDeg: 20 },
    camera,
    MOON_RADIUS_M,
    width,
    height,
  );
  const north = projectPlace(
    { name: "north", latitudeDeg: 20, longitudeDeg: 0 },
    camera,
    MOON_RADIUS_M,
    width,
    height,
  );
  const eastOnScreen = eastDir[0] * right.x + eastDir[1] * right.y + eastDir[2] * right.z;
  const northOnScreen = northDir[0] * up.x + northDir[1] * up.y + northDir[2] * up.z;
  assert.ok(eastOnScreen * (east.x - center.x) > 0);
  assert.ok(northOnScreen * (center.y - north.y) > 0);

  const apollo11 = projectPlace(APOLLO_LANDING_SITES[0], camera, MOON_RADIUS_M, width, height);
  assert.ok(apollo11.visible);
  assert.equal(Math.sign(apollo11.x - center.x), Math.sign(east.x - center.x));

  const farSide: Place = { name: "far", latitudeDeg: 0, longitudeDeg: 180 };
  assert.equal(projectPlace(farSide, camera, MOON_RADIUS_M, width, height).visible, false);

  camera.lookAt(MOON_RADIUS_M * 6, 0, 0);
  camera.updateMatrixWorld();
  assert.equal(
    projectPlace(
      { name: "subcamera", latitudeDeg: 0, longitudeDeg: 0 },
      camera,
      MOON_RADIUS_M,
      width,
      height,
    ).visible,
    false,
  );
});
