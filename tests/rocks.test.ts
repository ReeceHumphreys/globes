import assert from "node:assert/strict";
import test from "node:test";
import {
  ROCK_BURY,
  ROCK_CAPACITY,
  ROCK_RANGE_M,
  ROCK_SHOW_ALTITUDE_M,
  scatterRocks,
} from "../examples/moon/rendering/rocks.ts";

const RADIUS = 1_737_400;

function field(height: (x: number, y: number, z: number) => number) {
  const centers = new Float32Array(ROCK_CAPACITY * 3);
  const axes = new Float32Array(ROCK_CAPACITY * 9);
  const seeds = new Float32Array(ROCK_CAPACITY);
  return {
    centers,
    axes,
    seeds,
    fill(x: number, y: number, z: number) {
      return scatterRocks(x, y, z, RADIUS, height, centers, axes, seeds);
    },
  };
}

function world(centers: Float32Array, index: number, camera: [number, number, number]) {
  const o = index * 3;
  return [centers[o] + camera[0], centers[o + 1] + camera[1], centers[o + 2] + camera[2]];
}

test("rocks appear only near the surface, sit on the height sample, and stay put when the camera moves", () => {
  const flat = field(() => 0);
  assert.equal(flat.fill(RADIUS * 3, 0, 0), 0);
  assert.equal(flat.fill(RADIUS + ROCK_SHOW_ALTITUDE_M + 1, 0, 0), 0);

  const low: [number, number, number] = [RADIUS + 20, 0, 0];
  const count = flat.fill(...low);
  assert.ok(count > 20 && count < ROCK_CAPACITY);
  const rangeSq = ROCK_RANGE_M * ROCK_RANGE_M;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const rx = flat.centers[o],
      ry = flat.centers[o + 1],
      rz = flat.centers[o + 2];
    assert.ok(rx * rx + ry * ry + rz * rz <= rangeSq + 1e-6);
    const [x, y, z] = world(flat.centers, i, low);
    const len = Math.hypot(x, y, z);
    const scale = Math.hypot(flat.axes[i * 9 + 3], flat.axes[i * 9 + 4], flat.axes[i * 9 + 5]);
    assert.ok(Math.abs(len - (RADIUS + scale * ROCK_BURY)) < 1e-4);
    const ax = flat.axes.subarray(i * 9, i * 9 + 3);
    const ay = flat.axes.subarray(i * 9 + 3, i * 9 + 6);
    const az = flat.axes.subarray(i * 9 + 6, i * 9 + 9);
    const cross = [
      ax[1] * ay[2] - ax[2] * ay[1],
      ax[2] * ay[0] - ax[0] * ay[2],
      ax[0] * ay[1] - ax[1] * ay[0],
    ];
    assert.ok(
      cross[0] * az[0] + cross[1] * az[1] + cross[2] * az[2] > 0.99 * scale * scale * scale,
    );
    assert.ok(Math.abs(ay[0] * x + ay[1] * y + ay[2] * z) / (scale * len) > 0.999);
  }

  const first = new Map<string, [number, number, number]>();
  for (let i = 0; i < count; i++) {
    const [x, y, z] = world(flat.centers, i, low);
    first.set(`${Math.round(x)}:${Math.round(y)}:${Math.round(z)}`, [x, y, z]);
  }
  const moved: [number, number, number] = [RADIUS + 20, 40, 0];
  const again = flat.fill(...moved);
  let shared = 0;
  for (let i = 0; i < again; i++) {
    const [x, y, z] = world(flat.centers, i, moved);
    const prior = first.get(`${Math.round(x)}:${Math.round(y)}:${Math.round(z)}`);
    if (!prior) continue;
    shared++;
    // Camera-relative positions are stored in float32, so the reconstructed
    // world position jitters by a fraction of a millimeter, not by meters.
    assert.ok(Math.hypot(prior[0] - x, prior[1] - y, prior[2] - z) < 2e-4);
  }
  assert.ok(shared > 10);

  const raised = field(() => 125);
  const camera: [number, number, number] = [0, RADIUS + 15, 0];
  const polar = raised.fill(...camera);
  assert.ok(polar > 10);
  for (let i = 0; i < polar; i++) {
    const [x, y, z] = world(raised.centers, i, camera);
    const len = Math.hypot(x, y, z);
    const scale = Math.hypot(
      raised.axes[i * 9 + 3],
      raised.axes[i * 9 + 4],
      raised.axes[i * 9 + 5],
    );
    assert.ok(Math.abs(len - (RADIUS + 125 + scale * ROCK_BURY)) < 1e-4);
    const ay = raised.axes.subarray(i * 9 + 3, i * 9 + 6);
    assert.ok((ay[0] * x + ay[1] * y + ay[2] * z) / (scale * len) > 0.999);
  }
});
