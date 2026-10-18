import assert from "node:assert/strict";
import test from "node:test";
import { handoffDistance, zoomToward } from "../examples/planets/zoom.ts";

test("scroll in moves closer and eases toward the body; scroll out moves away", () => {
  const camera = [0, 0, 100];
  const focus = [0, 0, 0];
  const closer = zoomToward(camera, focus, [0, 0, 40], -100, 1, 1000);
  assert.ok(closer.distance < 100);
  assert.ok(closer.focus[2] > 0 && closer.focus[2] < 40);
  assert.ok(Math.abs(closer.yaw) < 1e-12);
  const farther = zoomToward(camera, focus, [0, 0, 40], 100, 1, 1000);
  assert.ok(farther.distance > 100);
  assert.equal(farther.focus[2], 0);
});

test("handoff keeps the globe camera inside its orbit range", () => {
  const radius = 100;
  assert.equal(handoffDistance(radius, 500), 500);
  assert.equal(handoffDistance(radius, 5000), 800);
  assert.equal(handoffDistance(radius, 50), 320);
});
