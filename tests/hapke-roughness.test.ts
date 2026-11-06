import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hapkeReference } from "../src/rendering/hapke.ts";
import { B0, disk, G, H, reflectance, rough, smoothstep, W } from "./support/hapke-isis.ts";

function principal(phaseDeg: number, emissionDeg: number): [number, number, number] {
  const phase = (phaseDeg * Math.PI) / 180;
  const emission = (emissionDeg * Math.PI) / 180;
  return [Math.cos(emission - phase), Math.cos(emission), Math.cos(phase)];
}

test("20° roughness keeps nadir at 1 and darkens the bright limb", () => {
  assert.ok(Math.abs(reflectance(1, 1, 1, 20) - 1) < 1e-6);
  const lookDown80 = Math.cos((80 * Math.PI) / 180);
  const faceOn =
    reflectance(lookDown80, 1, lookDown80, 20) / reflectance(lookDown80, 1, lookDown80, 0);
  assert.ok(faceOn < 1);
  assert.ok(Math.abs(faceOn - 0.832) < 0.02);
  // Phase 60°, emission 85°, incidence 25°. Both values sit above the fragment
  // shade floor, so this limb drop is the one that shows on a lit disk.
  const [limbMu0, limbMu, limbPhase] = principal(60, 85);
  const smoothLimb = reflectance(limbMu0, limbMu, limbPhase, 0);
  const roughLimb = reflectance(limbMu0, limbMu, limbPhase, 20);
  assert.ok(Math.abs(smoothLimb - 0.5) < 0.02);
  assert.ok(Math.abs(roughLimb - 0.406) < 0.02);
  assert.ok(Math.abs(roughLimb / smoothLimb - 0.812) < 0.02);
  const full = Math.cos((70 * Math.PI) / 180);
  assert.ok(Math.abs(reflectance(full, full, 1, 20) - 1) < 0.03);
});

test("zero roughness matches the smooth disk, and the night side stays dark", () => {
  for (const [mu0, mu, phase] of [
    [1, 1, 1],
    [0.5, 0.8, 0.2],
    [0.174, 1, 0.174],
    [0.906, 0.087, 0.5],
  ] as const) {
    const smooth = reflectance(mu0, mu, phase, 0);
    const direct = disk(mu0, mu, phase) / disk(1, 1, 1);
    assert.ok(Math.abs(smooth - direct) < 1e-6);
    assert.ok(Number.isFinite(reflectance(mu0, mu, phase, 20)));
  }
  assert.equal(reflectance(-0.2, 1, 0, 20), 0);
  assert.ok(Number.isFinite(reflectance(0.001, 0.001, -1, 20)));
});

test("fragment shade floor obeys surface orientation and occlusion", () => {
  const source = readFileSync("src/rendering/shaders/fragment.wgsl", "utf8");
  const visibility = readFileSync("src/rendering/shaders/solar-visibility.wgsl", "utf8");
  assert.match(source, /shadowedShade\(reflectance, ndotl, sunlight\)/);
  assert.match(visibility, /max\(reflectance, daylightFloor\) \* clamp\(visibility, 0\.0, 1\.0\)/);
  const shade = (ndotl: number, reflectance = 0, sunlight = 1) =>
    Math.max(reflectance, smoothstep(0, 0.25, ndotl) * 0.24) * Math.max(0, Math.min(1, sunlight));
  assert.equal(shade(-0.1), 0);
  assert.equal(shade(0), 0);
  assert.equal(shade(1), 0.24);
  assert.equal(shade(1, 1, 1), 1);
  assert.equal(shade(1, 1, 0), 0, "an occluded Sun-facing slope must be dark");
  assert.equal(shade(1, 0, 0), 0, "the daylight floor must not leak through shadow");
  assert.equal(shade(1, 0, 0.5), 0.12, "partial visibility attenuates the floor too");
});

test("hapke shader uses one 20° slope and the rough nadir", () => {
  const source = readFileSync("src/rendering/shaders/hapke.wgsl", "utf8");
  assert.match(source, /radians\(20\.0\)/);
  assert.doesNotMatch(source, /let reference = hapkeRough/);
  assert.ok(Math.abs(hapkeReference([W, G, B0, H]) - rough(1, 1, 1, 20)) < 1e-12);
  assert.match(source, /smoothstep\(-0\.03, 0\.08, mu0Raw\)/);
  assert.match(source, /smoothstep\(0\.0, 0\.06, muRaw\)/);
  assert.doesNotMatch(source, /theta\s*=\s*0|Smooth-surface|referenceH/);
});
