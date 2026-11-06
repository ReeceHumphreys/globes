import assert from "node:assert/strict";
import test from "node:test";
import { createTileBatch, TILE_BYTES } from "../src/tiles/tile.ts";
import { FACE_COUNT, FACE_NAMES } from "../src/tiles/roots.ts";
import { selectTiles } from "../src/tiles/quadtree.ts";
import { createSelectionView, VIEW } from "../src/tiles/lod.ts";
import { createResidentTiles } from "../src/tiles/resident-tiles.ts";
import { tileColor } from "../src/rendering/tile-colors.ts";
import {
  createTileInstances,
  writeTileInstances,
  INSTANCE_BYTES,
} from "../src/rendering/tile-instances.ts";
import { createTileProducer } from "../src/tile-producer.ts";

const radius = 1_737_400;

test("quadtree writes complete unique leaves into reusable SoA columns", () => {
  const tiles = createTileBatch(384);
  const columns = [tiles.face, tiles.level, tiles.x, tiles.y];
  for (const level of [0, 1, 2, 3, 2, 0]) {
    selectTiles(tiles, level);
    assert.equal(tiles.count, FACE_COUNT * 4 ** level);
    const addresses = new Set();
    const perFace = new Uint32Array(FACE_COUNT);
    for (let i = 0; i < tiles.count; i++) {
      assert.equal(tiles.level[i], level);
      assert.ok(tiles.x[i] < 2 ** level && tiles.y[i] < 2 ** level);
      addresses.add(`${tiles.face[i]}/${level}/${tiles.x[i]}/${tiles.y[i]}`);
      perFace[tiles.face[i]]++;
    }
    assert.equal(addresses.size, tiles.count);
    assert.deepEqual([...perFace], Array(6).fill(4 ** level));
    assert.deepEqual([tiles.face, tiles.level, tiles.x, tiles.y], columns);
  }
  // Depth-first child order is stable, preserving the previous traversal.
  selectTiles(tiles, 1);
  assert.deepEqual([...tiles.x.slice(0, 4)], [0, 1, 0, 1]);
  assert.deepEqual([...tiles.y.slice(0, 4)], [0, 0, 1, 1]);
});

test("capacity and invalid-level errors leave the previous selection intact", () => {
  const tiles = createTileBatch(24);
  selectTiles(tiles, 1);
  const before = new Uint8Array(tiles.buffer).slice();
  for (const level of [2, -1, 1.5, NaN, Infinity, 31]) {
    assert.throws(() => selectTiles(tiles, level), RangeError);
    assert.equal(tiles.count, 24);
    assert.deepEqual(new Uint8Array(tiles.buffer), before);
  }
  assert.throws(() => createTileBatch(0), RangeError);
  assert.throws(() => createTileBatch(1.5), RangeError);
});

test("numeric addresses pack into the correct cube faces at every level", () => {
  const tiles = createTileBatch(384);
  const instances = createTileInstances(384);
  assert.deepEqual([...FACE_NAMES], ["+X", "-X", "+Y", "-Y", "+Z", "-Z"]);
  for (let level = 0; level <= 3; level++) {
    selectTiles(tiles, level);
    writeTileInstances(tiles, instances, radius);
    assert.equal(instances.count, tiles.count);
    const sums = Array.from({ length: 6 }, () => [0, 0, 0]);
    for (let i = 0; i < tiles.count; i++) {
      const face = tiles.face[i];
      const center = [...instances.centers.slice(i * 3, i * 3 + 3)];
      const normalAxis = Math.floor(face / 2);
      assert.equal(center[normalAxis], ((face % 2 === 0 ? 1 : -1) * radius) / 2);
      assert.equal(instances.sizes[i * 2], radius / 2 ** level);
      assert.equal(instances.sizes[i * 2 + 1], radius / 2 ** level);
      center.forEach((value, axis) => (sums[face][axis] += value));
      for (let axis = 0; axis < 3; axis++) {
        if (axis !== normalAxis) assert.ok(Math.abs(center[axis]) < radius / 2);
      }
    }
    for (let face = 0; face < 6; face++) {
      for (let axis = 0; axis < 3; axis++) {
        if (axis !== Math.floor(face / 2)) assert.equal(sums[face][axis], 0);
      }
    }
  }
  const small = createTileInstances(6);
  assert.throws(() => writeTileInstances(tiles, small, radius), /capacity/);
  assert.equal(small.count, 0);
});

test("a tile that keeps failing reaches onError once, with its cause", async () => {
  const errors: Error[] = [];
  const tiles = createResidentTiles({
    slots: 6,
    label: "Test",
    maxLevel: () => 0,
    available: () => true,
    load: async () => {
      throw new Error("offline");
    },
    store: () => ({}),
    onChange() {},
    onError: (error) => errors.push(error as Error),
  });
  const instances = createTileInstances(1);
  instances.count = 1;
  instances.faceUVs.set([0, 0, 1, 1]);
  tiles.plan(instances, [1]);
  tiles.pump();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(errors.length, 6, "one for each root, after its retries");
  assert.match(errors[0].message, /Test tile 0\/0\/0\/0 failed/);
  assert.equal((errors[0].cause as Error).message, "offline");
  tiles.dispose();
});
