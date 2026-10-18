import assert from "node:assert/strict";
import test from "node:test";
import { reliefNormal } from "../src/elevation/relief-normal.ts";
import type { HeightField } from "../src/elevation/height-field.ts";
import { sunDirection } from "../src/rendering/sun.ts";

const radius = 1_737_400;

function field(values: Uint16Array, width: number, height: number): HeightField {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    const meters = value * 0.5 - 10000;
    min = Math.min(min, meters);
    max = Math.max(max, meters);
  }
  return { width, height, values, minMeters: min, maxMeters: max };
}

test("sun longitude follows +X at 0° and -Z at 90° east", () => {
  const equator = sunDirection(0, 0);
  assert.ok(Math.abs(equator[0] - 1) < 1e-12);
  assert.ok(Math.abs(equator[1]) < 1e-12);
  assert.ok(Math.abs(equator[2]) < 1e-12);
  const east = sunDirection(Math.PI / 2, 0);
  assert.ok(Math.abs(east[0]) < 1e-12);
  assert.ok(Math.abs(east[2] + 1) < 1e-12);
  const north = sunDirection(0, Math.PI / 2);
  assert.ok(Math.abs(north[1] - 1) < 1e-12);
});

test("relief normal stays outward and tilts back from an eastward rise", () => {
  const width = 360;
  const height = 180;
  const flat = field(new Uint16Array(width * height).fill(20000), width, height);
  const level = reliefNormal(flat, 1, 0, 0, radius, true);
  assert.ok(level[0] > 0.999);
  const pole = reliefNormal(flat, 0, 1, 0, radius, true);
  assert.ok(pole[1] > 0.999);
  const rising = new Uint16Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const steps = Math.max(-8, Math.min(8, col - width / 2));
      rising[row * width + col] = 20000 + steps * 3000;
    }
  }
  const sloped = reliefNormal(field(rising, width, height), 1, 0, 0, radius, true);
  assert.ok(sloped[0] > 0.9);
  assert.ok(sloped[2] > 0.02);
  const disabled = reliefNormal(field(rising, width, height), 1, 0, 0, radius, false);
  assert.ok(Math.abs(disabled[0] - 1) < 1e-12);
});
