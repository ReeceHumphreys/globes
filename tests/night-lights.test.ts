import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("night lights are emissive and fade across the terminator", () => {
  const source = readFileSync(
    new URL("../src/rendering/shaders/night-lights.wgsl", import.meta.url),
    "utf8",
  );
  const layer = readFileSync(new URL("../src/rendering/tile-layer.ts", import.meta.url), "utf8");
  assert.match(source, /return day \+ lights \* nightAmount \* enabled/);
  assert.match(source, /smoothstep\(-0\.12, 0\.02, dot\(normalize\(radial\), normalize\(sun\)\)\)/);
  assert.match(layer, /night-lights\.wgsl/);
  const smooth = (ndotl: number) => {
    const t = Math.min(1, Math.max(0, (ndotl + 0.12) / 0.14));
    return t * t * (3 - 2 * t);
  };
  const night = (ndotl: number) => 1 - smooth(ndotl);
  assert.ok(Math.abs(night(-1) - 1) < 1e-12);
  assert.ok(Math.abs(night(1)) < 1e-12);
  assert.ok(Math.abs(night(-0.05) - 0.5) < 1e-12);
});
