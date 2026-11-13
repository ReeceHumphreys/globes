import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CAP_HALF,
  gridShader,
  ROOT_COUNT,
  ROOT_EAST,
  ROOT_NORTH,
  ROOT_SOUTH,
  ROOT_WEST,
  rootDirection,
  rootMaxLevel,
  rootPoint,
  rootUV,
  tileInUse,
} from "../src/tiles/roots.ts";
import { geographicToDirection } from "../src/geographic.ts";
import { Vector3 } from "three/webgpu";

const direction = new Float64Array(3);

test("a direction and its root position survive the round trip on every root", () => {
  for (let root = 0; root < ROOT_COUNT; root++)
    for (const [u, v] of [
      [0.1, 0.2],
      [0.5, 0.5],
      [0.9, 0.7],
    ]) {
      rootDirection(root, u, v, direction);
      assert.ok(Math.abs(Math.hypot(...direction) - 1) < 1e-12);
      const [ru, rv] = rootUV(root, direction[0], direction[1], direction[2]);
      assert.ok(Math.abs(ru - u) < 1e-12 && Math.abs(rv - v) < 1e-12, `${root} ${u} ${v}`);
    }
});

test("geographic roots are plain latitude and longitude", () => {
  const expected = new Vector3();
  for (const [latitude, longitude] of [
    [10, 20],
    [-45, 170],
    [60, -120],
    [-30, -1],
  ]) {
    const root = longitude < 0 ? ROOT_WEST : ROOT_EAST;
    const u = (longitude + (root === ROOT_WEST ? 180 : 0)) / 180;
    rootDirection(root, u, (latitude + 90) / 180, direction);
    geographicToDirection(latitude, longitude, expected);
    assert.ok(expected.distanceTo(new Vector3(...direction)) < 1e-12);
    const [owner] = rootPoint(expected.x, expected.y, expected.z);
    assert.equal(owner, root);
  }
});

test("caps are centered on their pole, and own everything past the join", () => {
  rootDirection(ROOT_NORTH, 0.5, 0.5, direction);
  assert.deepEqual(
    [...direction].map((value) => Math.round(value) + 0),
    [0, 1, 0],
  );
  rootDirection(ROOT_SOUTH, 0.5, 0.5, direction);
  assert.deepEqual(
    [...direction].map((value) => Math.round(value) + 0),
    [0, -1, 0],
  );
  const at = new Vector3();
  for (const [latitude, root] of [
    [80, ROOT_EAST],
    [81, ROOT_NORTH],
    [-81, ROOT_SOUTH],
    [90, ROOT_NORTH],
    [-90, ROOT_SOUTH],
  ]) {
    geographicToDirection(latitude, 40, at);
    assert.equal(rootPoint(at.x, at.y, at.z)[0], root);
  }
});

test("seen from outside, both caps keep east to the right of north-up", () => {
  for (const root of [ROOT_NORTH, ROOT_SOUTH]) {
    const a = new Float64Array(3),
      b = new Float64Array(3),
      c = new Float64Array(3);
    rootDirection(root, 0.6, 0.6, a);
    rootDirection(root, 0.61, 0.6, b);
    rootDirection(root, 0.6, 0.61, c);
    const u = new Vector3(...b).sub(new Vector3(...a)),
      v = new Vector3(...c).sub(new Vector3(...a));
    assert.ok(u.cross(v).dot(new Vector3(...a)) > 0, `root ${root}`);
  }
});

test("a cap tile is the ground size of a geographic tile three levels deeper", () => {
  const capWidth = 4 * CAP_HALF;
  assert.ok(Math.abs(capWidth - Math.PI / 8) < 1e-12);
  assert.equal(rootMaxLevel(ROOT_EAST, 7), 7);
  assert.equal(rootMaxLevel(ROOT_NORTH, 7), 4);
  assert.equal(rootMaxLevel(ROOT_SOUTH, 2), 0);
});

test("only tiles reaching their part of the surface are in use", () => {
  assert.equal(tileInUse(ROOT_WEST, 0, 0, 0), true);
  assert.equal(tileInUse(ROOT_NORTH, 0, 0, 0), true);
  // The top row at level 5 is 84.4 to 90 degrees: the cap's alone.
  assert.equal(tileInUse(ROOT_EAST, 5, 3, 31), false);
  assert.equal(tileInUse(ROOT_EAST, 5, 3, 30), true);
  // A corner of a cap lies past the join on the geographic side.
  assert.equal(tileInUse(ROOT_NORTH, 5, 0, 0), false);
  assert.equal(tileInUse(ROOT_NORTH, 5, 16, 16), true);
});

test("every grid constant reaches the shaders that name it", () => {
  for (const name of ["direction", "point", "tangents", "join"]) {
    const file = new URL(`../src/rendering/shaders/root-${name}.wgsl`, import.meta.url);
    const filled = gridShader(readFileSync(file, "utf8"));
    assert.doesNotMatch(filled, /CAP_HALF|SIN_JOIN/);
  }
  assert.equal(gridShader("CAP_HALF"), "0.09817477");
  assert.equal(gridShader("SIN_JOIN_MIDDLE"), "0.98628560");
});
