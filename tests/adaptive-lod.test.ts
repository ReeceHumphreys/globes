import assert from "node:assert/strict";
import test from "node:test";
import { createTileBatch } from "../src/tiles/tile.ts";
import { selectAdaptiveTiles } from "../src/tiles/quadtree.ts";
import { VIEW, createSelectionView, projectedCellPixels } from "../src/tiles/lod.ts";

const radius = 1_737_400;
function makeView(x = 0, y = 0, z = 3) {
  const view = createSelectionView();
  view[VIEW.CameraX] = x * radius;
  view[VIEW.CameraY] = y * radius;
  view[VIEW.CameraZ] = z * radius;
  view[VIEW.Radius] = radius;
  view[VIEW.ProjectionScale] = 800 / (2 * Math.tan((75 * Math.PI) / 360));
  view[VIEW.Segments] = 32;
  view[VIEW.MaxCellPixels] = 12;
  view[VIEW.MaxLevel] = 3;
  return view;
}

function verifyCoverage(tiles, maxLevel) {
  const area = new Float64Array(6);
  const ids = new Set();
  for (let i = 0; i < tiles.count; i++) {
    const face = tiles.face[i],
      level = tiles.level[i],
      x = tiles.x[i],
      y = tiles.y[i];
    assert.ok(face < 6 && level <= maxLevel && x < 2 ** level && y < 2 ** level);
    const id = `${face}/${level}/${x}/${y}`;
    assert.equal(ids.has(id), false);
    ids.add(id);
    area[face] += 1 / 4 ** level;
  }
  assert.deepEqual([...area], [1, 1, 1, 1, 1, 1]);
  // No selected node may have a selected ancestor.
  for (let i = 0; i < tiles.count; i++) {
    let level = tiles.level[i],
      x = tiles.x[i],
      y = tiles.y[i];
    while (level > 0) {
      level--;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
      assert.equal(ids.has(`${tiles.face[i]}/${level}/${x}/${y}`), false);
    }
  }
}

const averageLevel = (tiles, face) => {
  // Weight by covered face area, not by number of leaves.
  let result = 0;
  for (let i = 0; i < tiles.count; i++) {
    if (tiles.face[i] === face) result += tiles.level[i] / 4 ** tiles.level[i];
  }
  return result;
};

test("adaptive leaves cover all faces without overlap at orbit and local views", () => {
  const tiles = createTileBatch(384);
  for (const camera of [
    [0, 0, 10],
    [0, 0, 3],
    [0, 0, 2],
    [0, 0, 1.2],
    [1.2, 0, 0],
    [0, -1.2, 0],
    [0, 0, -1.2],
    [1, 1, 1],
  ]) {
    const view = makeView(...camera);
    selectAdaptiveTiles(tiles, view);
    verifyCoverage(tiles, 3);
    // Non-max-depth leaves satisfy the configured screen-size heuristic.
    for (let i = 0; i < tiles.count; i++) {
      if (tiles.level[i] < 3) {
        assert.ok(
          projectedCellPixels(tiles.face[i], tiles.level[i], tiles.x[i], tiles.y[i], view) <=
            view[VIEW.MaxCellPixels],
        );
      }
    }
  }
});

test("near regions refine more and detail follows orbiting at fixed altitude", () => {
  const tiles = createTileBatch(384);
  selectAdaptiveTiles(tiles, makeView(0, 0, 1.2));
  assert.ok(tiles.count < 384);
  assert.ok(new Set(tiles.level.slice(0, tiles.count)).size > 1);
  assert.ok(averageLevel(tiles, 4) > averageLevel(tiles, 5));
  const before = averageLevel(tiles, 4);
  selectAdaptiveTiles(tiles, makeView(0, 0, -1.2));
  assert.ok(averageLevel(tiles, 5) > averageLevel(tiles, 4));
  assert.equal(averageLevel(tiles, 5), before);
  selectAdaptiveTiles(tiles, makeView(1.2, 0, 0));
  assert.ok(averageLevel(tiles, 0) > averageLevel(tiles, 1));
});

test("distance, viewport, and quality control refinement; depth stays capped", () => {
  const tiles = createTileBatch(384);
  let previous = 0;
  for (const distance of [10, 3, 2, 1.5, 1.2]) {
    selectAdaptiveTiles(tiles, makeView(0, 0, distance));
    assert.ok(tiles.count >= previous);
    previous = tiles.count;
  }
  const view = makeView();
  selectAdaptiveTiles(tiles, view);
  const standard = tiles.count;
  view[VIEW.ProjectionScale] *= 2;
  selectAdaptiveTiles(tiles, view);
  assert.ok(tiles.count >= standard);
  view[VIEW.MaxCellPixels] *= 4;
  selectAdaptiveTiles(tiles, view);
  assert.ok(tiles.count <= standard);
  view[VIEW.MaxLevel] = 0;
  selectAdaptiveTiles(tiles, view);
  assert.equal(tiles.count, 6);
});

test("invalid query/capacity failures preserve the previous buffer contents", () => {
  const tiles = createTileBatch(384);
  const view = makeView();
  selectAdaptiveTiles(tiles, view);
  const before = new Uint8Array(tiles.buffer).slice();
  const count = tiles.count;
  for (const [field, value] of [
    [VIEW.Radius, 0],
    [VIEW.ProjectionScale, NaN],
    [VIEW.MaxLevel, 31],
    [VIEW.Segments, 0],
    [VIEW.MaxCellPixels, -1],
  ]) {
    const invalid = view.slice();
    invalid[field] = value;
    assert.throws(() => selectAdaptiveTiles(tiles, invalid), RangeError);
    assert.equal(tiles.count, count);
    assert.deepEqual(new Uint8Array(tiles.buffer), before);
  }
});

test("surface inspection reaches deep local levels within a fixed tile budget", () => {
  for (const capacity of [6, 96, 2048]) {
    const tiles = createTileBatch(capacity);
    const view = makeView();
    view[VIEW.MaxLevel] = 20;
    for (const direction of [
      [0, 0, 1],
      [1, 0, 0],
      [1, 1, 1],
      [1, 0, 1],
    ]) {
      const norm = Math.hypot(...direction);
      for (let axis = 0; axis < 3; axis++) view[axis] = (direction[axis] / norm) * (radius + 10);
      selectAdaptiveTiles(tiles, view);
      assert.ok(tiles.count <= capacity);
      verifyCoverage(tiles, 20);
      if (capacity === 2048) assert.ok(Math.max(...tiles.level.slice(0, tiles.count)) >= 15);
    }
  }
  const tooSmall = createTileBatch(5);
  assert.throws(() => selectAdaptiveTiles(tooSmall, makeView()), RangeError);
  assert.equal(tooSmall.count, 0);
});
