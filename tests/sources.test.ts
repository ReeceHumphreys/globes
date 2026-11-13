import assert from "node:assert/strict";
import test from "node:test";
import { Group, PerspectiveCamera, Vector3 } from "three/webgpu";
import { resolveHeights, resolveImagery } from "../src/sources.ts";
import { createCameraView } from "../src/camera-view.ts";
import { VIEW } from "../src/tiles/lod.ts";
import type { HeightSource } from "../src/elevation/source.ts";
import type { ImagerySource } from "../src/imagery/source.ts";

function context(signal = new AbortController().signal) {
  const errors: unknown[] = [];
  return { errors, url: (path: string) => path, signal, report: (e: unknown) => errors.push(e) };
}
function heights(verticalDatum: string) {
  let disposed = false;
  const source = {
    verticalDatum,
    dispose: () => void (disposed = true),
  } as unknown as HeightSource;
  return { source, disposed: () => disposed };
}

test("a given imagery source is used as is", async () => {
  const source = { load: async () => new Uint8Array() } as unknown as ImagerySource;
  assert.deepEqual(await resolveImagery(source, context()), { source });
  assert.deepEqual(await resolveImagery(undefined, context()), {});
});

test("a flattened body rejects heights that are not ellipsoidal, and frees them", async () => {
  const geoid = heights("geoid"),
    c = context();
  assert.equal(await resolveHeights(geoid.source, 1 / 298, c), undefined);
  assert.ok(geoid.disposed());
  assert.match(String(c.errors[0]), /geoid, not the ellipsoid/);

  const ellipsoid = heights("ellipsoid");
  assert.equal(await resolveHeights(ellipsoid.source, 1 / 298, context()), ellipsoid.source);
  const sphere = heights("sphere");
  assert.equal(await resolveHeights(sphere.source, 0, context()), sphere.source);
});

test("heights resolved after a cancel are freed", async () => {
  const controller = new AbortController(),
    h = heights("sphere");
  controller.abort();
  assert.equal(await resolveHeights(h.source, 0, context(controller.signal)), undefined);
  assert.ok(h.disposed());
});

test("the camera view is in the globe's frame and allows for flattening", () => {
  const radius = 1000,
    flattening = 0.01;
  const cameraView = createCameraView({
    radius,
    flattening,
    segments: 8,
    maxLevel: 10,
    cellPixels: 4,
  });
  const globe = new Group();
  globe.position.set(5000, 0, 0);
  globe.rotation.y = Math.PI / 2; // the globe's +x faces world -z
  const camera = new PerspectiveCamera(60, 1, 1, 1e5);
  camera.position.set(5000, 0, -3000);
  camera.lookAt(globe.position);
  cameraView.update(globe, camera, false, 600);
  assert.ok(cameraView.position.distanceTo(new Vector3(3000, 0, 0)) < 1e-9);
  assert.ok(cameraView.forward.distanceTo(new Vector3(-1, 0, 0)) < 1e-9);
  // Over the equator the matching sphere point is the camera itself.
  assert.ok(Math.abs(cameraView.view[VIEW.CameraX] - 3000) < 1e-6);
  assert.ok(Math.abs(cameraView.view[VIEW.ProjectionScale] - 300 / Math.tan(Math.PI / 6)) < 1e-9);
  cameraView.setHeights({ minMeters: 50, maxMeters: 200 });
  assert.equal(cameraView.view[VIEW.MinElevation], -radius * flattening);
  assert.equal(cameraView.view[VIEW.MaxElevation], 200);
});
