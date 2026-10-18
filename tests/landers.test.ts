import assert from "node:assert/strict";
import test from "node:test";
import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Vector3 } from "three/webgpu";
import {
  normalizeLander,
  landerOrientation,
  LM_HEIGHT_M,
} from "../examples/moon/rendering/landers.ts";
import { APOLLO_LANDING_SITES, placeDirection } from "../examples/moon/places.ts";
import { LUNAR_PLACES, SHACKLETON } from "../examples/moon/data/landmarks.ts";

test("LM normalization places feet on ground at real meter scale", () => {
  const mesh = new Mesh(new BoxGeometry(6.4, 5, 6.4), new MeshBasicMaterial());
  mesh.position.set(20, 12, -5);
  const root = normalizeLander(mesh);
  root.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(root);
  assert.ok(Math.abs(bounds.min.y) < 1e-10);
  assert.ok(Math.abs(bounds.max.y - LM_HEIGHT_M) < 1e-10);
  assert.ok(bounds.getCenter(new Vector3()).setY(0).length() < 1e-10);
  mesh.geometry.dispose();
  mesh.material.dispose();
});

test("all landing frames orient model up radially with a right handed tangent frame", () => {
  for (const place of [...APOLLO_LANDING_SITES, SHACKLETON]) {
    const q = landerOrientation(place);
    const up = new Vector3(0, 1, 0).applyQuaternion(q);
    assert.ok(up.distanceTo(new Vector3(...placeDirection(place))) < 1e-12);
    const x = new Vector3(1, 0, 0).applyQuaternion(q);
    const z = new Vector3(0, 0, 1).applyQuaternion(q);
    assert.ok(new Vector3().crossVectors(x, up).distanceTo(z) < 1e-12);
    // Preserve centimeter offsets when subtracting lunar coordinates in float64.
    const world = up.clone().multiplyScalar(1737400 - 1422);
    const camera = world.clone().addScaledVector(up, 10);
    const relative = world.clone().sub(camera);
    assert.ok(Math.abs(relative.length() - 10) < 1e-8);
  }
  assert.equal(APOLLO_LANDING_SITES.length, 6);
  assert.ok(LUNAR_PLACES.length > APOLLO_LANDING_SITES.length);
  assert.ok(APOLLO_LANDING_SITES.every((site) => LUNAR_PLACES.includes(site)));
  assert.deepEqual([SHACKLETON.latitudeDeg, SHACKLETON.longitudeDeg], [-89.67, 129.78]);
});
