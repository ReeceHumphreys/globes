import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("close-up grain multiplies magnified imagery and stays off sharp tiles", () => {
  const fragment = readFileSync("src/rendering/shaders/fragment.wgsl", "utf8");
  const detail = readFileSync("src/rendering/shaders/surface-detail.wgsl", "utf8");
  const entry = fragment
    .replace(/^(?:\s*\/\/[^\r\n]*|\s*\/\*[\s\S]*?\*\/|\s*)+/, "")
    .match(/^[fn]*\s*([a-z_0-9]+)?\s*\(([\s\S]*?)\)\s*[\-\>]*\s*([a-z_0-9]+(?:<[\s\S]+?>)?)/i);
  assert.equal(entry?.[1], "fragmentColor");
  assert.equal(entry?.[3], "vec3<f32>");
  assert.doesNotMatch(fragment, /fn detailWeight/);
  assert.doesNotMatch(fragment, /\?/);
  assert.match(fragment, /detailWeight\(texels\)/);
  assert.match(fragment, /surface \*= mix\(vec3<f32>\(1\.0\), vec3<f32>\(grain\), weight\)/);
  assert.match(detail, /1\.0 - smoothstep\(0\.55, 1\.6, texelsPerPixel\)/);
  assert.match(detail, /direction \* \(radius \/ scale\)/);
  assert.match(detail, /scale \/ max\(pixelMeters, 0\.0001\)/);
  assert.equal(detailWeight(2), 0);
  assert.equal(detailWeight(0.5), 1);
  assert.equal(detailWeight(0), 0);
});

function detailWeight(texelsPerPixel: number): number {
  if (texelsPerPixel <= 0) return 0;
  const t = Math.min(1, Math.max(0, (texelsPerPixel - 0.55) / (1.6 - 0.55)));
  const smooth = t * t * (3 - 2 * t);
  return 1 - smooth;
}
