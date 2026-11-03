import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createSunlightCacheState,
  terrainCacheSettings,
} from "../src/rendering/terrain-cache-state.ts";

test("sunlight entries survive camera-only frames and invalidate for input, binding, and epoch changes", () => {
  const state = createSunlightCacheState(2),
    signature = new Float32Array(12).fill(1);
  assert.equal(state.begin("sunA/height1", 0), 0);
  const a = state.touch("face0/patch", signature)!;
  a.ready = true;
  assert.equal(state.begin("sunA/height1", 100), 0);
  assert.equal(state.touch("face0/patch", signature), a);
  assert.equal(a.ready, true);
  signature[2] = 0.25;
  assert.equal(
    state.touch("face0/patch", signature)!.ready,
    false,
    "source UV changes must discard sunlight",
  );
  a.ready = true;
  state.begin("sunB/height1", 200);
  assert.equal(state.ready, 0);
  const b = state.touch("face0/patch", signature)!;
  assert.equal(b.ready, false);
  b.ready = true;
  state.begin("sunB/height2", 300);
  assert.equal(state.ready, 0, "new occluder anywhere invalidates shadows");
});
test("bounded sunlight cache protects the current frame and evicts old patches safely", () => {
  const state = createSunlightCacheState(2),
    sig = new Float32Array(12);
  state.begin("A", 0);
  const first = state.touch("a", sig)!,
    second = state.touch("b", sig)!;
  first.ready = second.ready = true;
  assert.equal(state.touch("c", sig), undefined);
  assert.equal(state.size, 2);
  state.begin("A", 1);
  state.touch("a", sig);
  const replacement = state.touch("c", sig)!;
  assert.equal(replacement.slot, second.slot);
  assert.equal(replacement.ready, false);
  assert.equal(first.ready, true);
  assert.equal(state.size, 2);
  state.clear();
  state.begin("A", 2);
  assert.equal(state.size, 0);
  assert.equal(state.touch("d", sig)!.ready, false);
});
test("cache budgets validate before allocating GPU resources", () => {
  assert.equal(terrainCacheSettings().sunlightSlots, 128);
  for (const sunlightSlots of [0, 256, Infinity, 1.5])
    assert.throws(() => terrainCacheSettings({ sunlightSlots }));
  for (const settleMs of [-1, Infinity, NaN])
    assert.throws(() => terrainCacheSettings({ settleMs }));
});
test("a draw-time sunlight miss does not ray-march", () => {
  const cached = readFileSync(
    new URL("../src/rendering/shaders/cached-sunlight.wgsl", import.meta.url),
    "utf8",
  );
  const march = readFileSync(
    new URL("../src/rendering/shaders/terrain-sunlight.wgsl", import.meta.url),
    "utf8",
  );
  assert.match(cached, /textureLoad\(cache,/);
  assert.match(cached, /terrainSunlight\([\s\S]*enabled,0\.0\);/);
  assert.match(march, /steps<1\.0/);
});
