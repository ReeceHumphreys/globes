import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hapkeReference } from "../src/rendering/hapke.ts";

// ISIS Hapke roughness (PhotoModelAlgorithm) at the visualization preset.
// This locks the curve the shader transcribes. It does not compile or run the WGSL.
const W = 0.23;
const G = -0.3;
const B0 = 1;
const H = 0.05;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function disk(mu0: number, mu: number, phase: number): number {
  const mu0c = Math.max(mu0, 0.0001);
  const muc = Math.max(mu, 0.0001);
  const phaseDenominator = Math.max(0.0001, 1 + 2 * G * phase + G * G);
  const particle = (1 - G * G) / phaseDenominator ** 1.5;
  const halfTangent = Math.sqrt(Math.max(0, (1 - phase) / Math.max(0.000001, 1 + phase)));
  const opposition = B0 / (1 + halfTangent / H);
  const gamma = Math.sqrt(1 - W);
  const h0 = (1 + 2 * mu0c) / (1 + 2 * mu0c * gamma);
  const he = (1 + 2 * muc) / (1 + 2 * muc * gamma);
  return (
    W * 0.25 * (mu0c / Math.max(0.000001, mu0c + muc)) * ((1 + opposition) * particle + h0 * he - 1)
  );
}

function rough(mu0: number, mu: number, phase: number, thetaDeg: number): number {
  const theta = (thetaDeg * Math.PI) / 180;
  const cost = Math.cos(theta);
  const sint = Math.sin(theta);
  const cott = cost / Math.max(sint, 1e-10);
  const cot2t = cott * cott;
  const tant = sint / Math.max(cost, 1e-10);
  const sr = Math.sqrt(1 + Math.PI * tant * tant);
  const osr = 1 / sr;
  const sinI = Math.sqrt(Math.max(0, 1 - mu0 * mu0));
  const sinE = Math.sqrt(Math.max(0, 1 - mu * mu));
  const cotI = mu0 / Math.max(sinI, 1e-10);
  const cotE = mu / Math.max(sinE, 1e-10);
  const eexp = (arg: number) => Math.exp(Math.min(23, Math.max(-40, arg)));
  const ecotI = eexp((-cot2t * cotI * cotI) / Math.PI);
  const ecot2I = eexp((-2 * cott * cotI) / Math.PI);
  const ecotE = eexp((-cot2t * cotE * cotE) / Math.PI);
  const ecot2E = eexp((-2 * cott * cotE) / Math.PI);
  const u0p0 = osr * (mu0 + (sinI * tant * ecotI) / Math.max(2 - ecot2I, 1e-6));
  const up0 = osr * (mu + (sinE * tant * ecotE) / Math.max(2 - ecot2E, 1e-6));
  const sinEI = sinE * sinI;
  let caz = 1;
  let az = 0;
  if (sinEI > 1e-8) {
    caz = Math.min(1, Math.max(-1, (phase - mu * mu0) / sinEI));
    az = Math.acos(caz);
  }
  const az2 = az * 0.5;
  let faz = 0;
  if (caz > -0.999999) faz = eexp(-2 * Math.tan(az2));
  const sin2a2 = Math.sin(az2) ** 2;
  const api = az / Math.PI;
  let q = 1;
  let u0p = u0p0;
  let up = up0;
  if (mu0 >= mu) {
    q = (osr * mu0) / Math.max(u0p0, 1e-6);
    const ecei = Math.max(2 - ecot2E - api * ecot2I, 1e-6);
    const s2ei = sin2a2 * ecotI;
    u0p = osr * (mu0 + (sinI * tant * (caz * ecotE + s2ei)) / ecei);
    up = osr * (mu + (sinE * tant * (ecotE - s2ei)) / ecei);
  } else {
    q = (osr * mu) / Math.max(up0, 1e-6);
    const ecee = Math.max(2 - ecot2I - api * ecot2E, 1e-6);
    const s2ee = sin2a2 * ecotE;
    u0p = osr * (mu0 + (sinI * tant * (ecotI - s2ee)) / ecee);
    up = osr * (mu + (sinE * tant * (caz * ecotI + s2ee)) / ecee);
  }
  const rr1 = disk(u0p, up, phase);
  const shadow = Math.max(1 - faz + faz * q, 1e-6);
  const rr2 = (up * mu0) / Math.max(up0 * u0p0 * sr * shadow, 1e-6);
  return Math.max(0, rr1 * rr2);
}

function reflectance(mu0Raw: number, muRaw: number, phase: number, thetaDeg: number): number {
  const mu0 = Math.max(mu0Raw, 0.001);
  const mu = Math.max(muRaw, 0.001);
  const value = rough(mu0, mu, phase, thetaDeg);
  const reference = rough(1, 1, 1, thetaDeg);
  const fade = smoothstep(-0.03, 0.08, mu0Raw) * smoothstep(0, 0.06, muRaw);
  return Math.max(0, value / Math.max(reference, 0.000001)) * fade;
}

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
