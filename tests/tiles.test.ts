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

test("default producer reuses buffers and skips unchanged instance packing", () => {
  const produce = createTileProducer(384);
  const view = createSelectionView();
  view[VIEW.CameraZ] = radius * 10;
  view[VIEW.Radius] = radius;
  view[VIEW.ProjectionScale] = 800 / (2 * Math.tan((75 * Math.PI) / 360));
  view[VIEW.Segments] = 32;
  view[VIEW.MaxCellPixels] = 12;
  view[VIEW.MaxLevel] = 3;
  const first = produce(view);
  const arrays = [first.sizes, first.rotations, first.centers, first.colors];
  const initialRevision = first.revision;
  assert.equal(first.count, 6);
  assert.equal(produce(view).revision, initialRevision);
  // Translation changes camera-relative anchors even when leaves are unchanged.
  view[VIEW.CameraX] = radius * 0.001;
  assert.equal(produce(view).revision, initialRevision + 1);
  view[VIEW.CameraX] = 0;
  for (const distance of [3, 2, 1.5, 1.2, 10]) {
    view[VIEW.CameraZ] = radius * distance;
    const oldRevision = first.revision;
    const next = produce(view);
    assert.equal(next, first);
    assert.ok(next.count >= 6 && next.count <= 384);
    assert.equal(next.revision, oldRevision + 1);
    [next.sizes, next.rotations, next.centers, next.colors].forEach((array, i) =>
      assert.equal(array, arrays[i]),
    );
  }
});

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

test("numeric quadrant bits preserve the parent-derived debug palette", () => {
  assert.deepEqual(
    Array.from({ length: 6 }, (_, face) => tileColor(face, 0, 0, 0)),
    [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff],
  );
  assert.deepEqual(
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ].map(([x, y]) => tileColor(4, 1, x, y)),
    [9832878, 11405718, 14504438, 16142813],
  );
  assert.equal(tileColor(4, 2, 0, 1), 11942122);
});

test("tile and instance columns keep a fixed order in one buffer", () => {
  const tiles = createTileBatch(24);
  const instances = createTileInstances(24);
  assert.equal(tiles.buffer.byteLength, 24 * TILE_BYTES);
  assert.equal(tiles.x.byteOffset, 2 * 24 * 4);
  assert.equal(instances.buffer.byteLength, 24 * INSTANCE_BYTES);
  assert.equal(instances.centers.byteOffset, 4 * 24 * 4);
  assert.equal(instances.faces.byteOffset, 17 * 24 * 4);
});

test("resident tiles plan again only when their inputs change", () => {
  let checks = 0;
  const tiles = createResidentTiles({
    slots: 6,
    label: "Test",
    maxLevel: () => 1,
    available: () => (checks++, true),
    load: async () => ({}),
    store: () => ({}),
    onChange() {},
  });
  const instances = createTileInstances(1);
  instances.count = 1;
  instances.faceUVs.set([0, 0, 0.5, 0.5]);
  instances.origin.set([1, 0, 0]);
  tiles.plan(instances, [1]);
  const planned = checks;
  assert.ok(planned > 0);
  tiles.plan(instances, [1]);
  assert.equal(checks, planned);
  tiles.plan(instances, [2]);
  assert.ok(checks > planned);
  const reprioritized = checks;
  tiles.invalidate();
  tiles.plan(instances, [2]);
  assert.ok(checks > reprioritized);
  tiles.dispose();
});
