import assert from "node:assert/strict";
import test from "node:test";
import type * as THREE from "three/webgpu";
import { Clouds } from "../src/atmosphere/clouds.ts";

const loaded = () => {
  const clouds = new Clouds({ map: "clouds.jpg", fadeAltitudes: [100, 300], altitude: 10 });
  clouds.map = {} as THREE.Texture;
  return clouds;
};

test("clouds are absent below the fade, solid above it, and rise smoothly between", () => {
  const clouds = loaded();
  assert.equal(clouds.strengthAt(0), 0);
  assert.equal(clouds.strengthAt(100), 0);
  assert.equal(clouds.strengthAt(200), 0.5);
  assert.equal(clouds.strengthAt(300), 1);
  assert.equal(clouds.strengthAt(1e9), 1);
});

test("clouds show nothing until the map loads, or when hidden", () => {
  assert.equal(new Clouds({ map: "clouds.jpg" }).strengthAt(1e9), 0);
  const clouds = loaded();
  clouds.visible = false;
  assert.equal(clouds.strengthAt(1e9), 0);
});

test("a fade that could put the camera inside the layer is rejected", () => {
  assert.throws(
    () => new Clouds({ map: "c", altitude: 200, fadeAltitudes: [100, 300] }),
    RangeError,
  );
  assert.throws(() => new Clouds({ map: "c", fadeAltitudes: [300_000, 100_000] }), RangeError);
  assert.throws(() => new Clouds({ map: "c", altitude: 0 }), RangeError);
});
