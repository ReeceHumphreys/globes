import assert from "node:assert/strict";
import test from "node:test";
import { createTileBatch } from "../src/tiles/tile.ts";
import { createTileInstances, writeTileInstances } from "../src/rendering/tile-instances.ts";
import { FACE_ROTATION_X, FACE_ROTATION_Y, faceToWorld, worldToFace } from "../src/tiles/roots.ts";

// Check the renderer's actual packed transform at matching physical locations.
test("face UVs agree across mixed-level neighbors and parent/child replacement", () => {
  const tiles = createTileBatch(3),
    instances = createTileInstances(3);
  const sample = (i, u, v) => {
    const t = instances.faceUVs,
      j = i * 4;
    return [t[j] + u * t[j + 2], t[j + 1] + v * t[j + 3]];
  };
  for (let face = 0; face < 6; face++)
    for (const level of [1, 3, 12, 20]) {
      tiles.count = 3;
      tiles.face.fill(face);
      const n = 2 ** level,
        x = Math.floor(n / 3),
        y = Math.floor(n / 4);
      tiles.level.set([level, level + 1, level + 1]);
      // Parent and its bottom-right child, plus a child in the adjacent region.
      tiles.x.set([x, 2 * x + 1, 2 * x + 2]);
      tiles.y.set([y, 2 * y, 2 * y]);
      writeTileInstances(tiles, instances, 1737400);
      for (const u of [0, 0.25, 0.5, 1])
        for (const v of [0, 0.5, 1]) {
          assert.deepEqual(sample(0, 0.5 + 0.5 * u, 0.5 * v), sample(1, u, v));
        }
      for (const v of [0, 0.125, 0.5, 1]) {
        assert.deepEqual(sample(0, 1, 0.5 * v), sample(2, 0, v));
      }
    }
});

test("cube face basis matches rotateX then rotateY and inverts", () => {
  const out = new Float64Array(3),
    back = new Float64Array(3);
  const exact = [
    [3, 2, -1],
    [-3, 2, 1],
    [1, 3, -2],
    [1, -3, 2],
    [1, 2, 3],
    [-1, 2, -3],
  ];
  for (let face = 0; face < 6; face++) {
    const u = 1,
      v = 2,
      w = 3;
    faceToWorld(face, u, v, w, out);
    assert.deepEqual([...out], exact[face]);
    worldToFace(face, out[0], out[1], out[2], back);
    assert.deepEqual([...back], [u, v, w]);
    const rx = FACE_ROTATION_X[face],
      ry = FACE_ROTATION_Y[face],
      cx = Math.cos(rx),
      sx = Math.sin(rx),
      cy = Math.cos(ry),
      sy = Math.sin(ry),
      y1 = cx * v - sx * w,
      z1 = sx * v + cx * w;
    // Rotations are float32, so the trig form used by the shader is not exact.
    assert.ok(Math.abs(out[0] - (cy * u + sy * z1)) < 1e-6);
    assert.ok(Math.abs(out[1] - y1) < 1e-6);
    assert.ok(Math.abs(out[2] - (-sy * u + cy * z1)) < 1e-6);
  }
});

test("packed tile centers use that face basis", () => {
  const tiles = createTileBatch(6),
    instances = createTileInstances(6),
    out = new Float64Array(3);
  tiles.count = 6;
  for (let face = 0; face < 6; face++) {
    tiles.face[face] = face;
    tiles.level[face] = 1;
    tiles.x[face] = 0;
    tiles.y[face] = 1;
  }
  writeTileInstances(tiles, instances, 4);
  for (let face = 0; face < 6; face++) {
    faceToWorld(face, -1, 1, 2, out);
    assert.equal(instances.centers[face * 3], out[0]);
    assert.equal(instances.centers[face * 3 + 1], out[1]);
    assert.equal(instances.centers[face * 3 + 2], out[2]);
  }
});
