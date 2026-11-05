import assert from "node:assert/strict";
import test from "node:test";
import { graticuleLevels } from "../src/graticule-levels.ts";

test("graticule spacing shrinks with the view, each level dividing the one before", () => {
  assert.deepEqual(graticuleLevels(69), [10, 5, 0]);
  let previous = graticuleLevels(69)[0];
  for (let view = 60; view > 0.001; view *= 0.9) {
    const [coarse, fine, strength] = graticuleLevels(view);
    assert.ok(coarse <= previous);
    const ratio = previous / coarse;
    assert.ok(Math.abs(ratio - Math.round(ratio)) < 1e-9);
    assert.ok(fine <= coarse && strength >= 0 && strength <= 1);
    previous = coarse;
  }
});

test("finer lines are fully in by the time they become the coarse level", () => {
  const justAbove = graticuleLevels(5 * 3 + 1e-6);
  assert.deepEqual(justAbove.slice(0, 2), [5, 1]);
  assert.ok(justAbove[2] > 0.999);
  assert.ok(graticuleLevels(10 * 3 - 1e-6)[2] < 0.001);
});
