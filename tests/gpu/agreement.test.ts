import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { DataUtils, Vector3 } from "three/webgpu";
import {
  buildAtmosphere,
  EARTH_AIR,
  SKY_LIGHT_WIDTH,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
} from "../../src/atmosphere/model.ts";
import { heightMeters, ZERO_HEIGHT_BYTES } from "../../src/elevation/tiles.ts";
import { ellipsoidOffset } from "../../src/ellipsoid.ts";
import { GRADIENT_READY_BIT, MAX_SUNLIGHT_SLOTS } from "../../src/rendering/binding-row.ts";
import { hapkeReference } from "../../src/rendering/hapke.ts";
import { facePoint } from "../../src/tiles/roots.ts";
import { B0, G, H, reflectance, W } from "../support/hapke-isis.ts";
import { openGpu } from "./run-wgsl.ts";

const gpu = await openGpu();
const skip = gpu ? false : "needs Chrome with WebGPU; set CHROME to its path";
after(() => gpu?.close());

const shader = (name: string) =>
  readFileSync(new URL(`../../src/rendering/shaders/${name}.wgsl`, import.meta.url), "utf8");

// Seeded, so a failure repeats. Rounded to float32, so both sides see the same inputs.
let seed = 12345;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return Math.fround(seed / 2 ** 32);
};
const direction = () => {
  const v = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
  return [Math.fround(v.x), Math.fround(v.y), Math.fround(v.z)];
};
const many = <T>(count: number, make: () => T) => Array.from({ length: count }, make);
const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

test("ellipsoid offsets agree", { skip }, async () => {
  const radius = 6378137,
    flattening = 1 / 298.257223563;
  const e2 = flattening * (2 - flattening);
  const cases = many(512, direction);
  const results = await gpu!.run({
    wgsl: [shader("ellipsoid-offset")],
    expression: `vec4<f32>(ellipsoidOffset(a.xyz, ${radius}.0, ${e2}), 0.0)`,
    cases,
  });
  const expected = new Vector3();
  cases.forEach(([x, y, z], i) => {
    ellipsoidOffset(new Vector3(x, y, z), radius, flattening, expected);
    expected
      .toArray()
      .forEach((value, axis) => near(results[i][axis], value, 0.05, `${x},${y},${z}`));
  });
});

test("cube faces and face UVs agree", { skip }, async () => {
  const cases = [
    ...many(2048, direction),
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const results = await gpu!.run({
    wgsl: [shader("face-point")],
    expression: `vec4<f32>(facePoint(a.xyz), 0.0)`,
    cases,
  });
  cases.forEach(([x, y, z], i) => {
    const [face, u, v] = facePoint(x, y, z);
    assert.equal(results[i][0], face, `${x},${y},${z}`);
    near(results[i][1], u, 1e-6, "u");
    near(results[i][2], v, 1e-6, "v");
  });
});

test("stored heights decode alike, and zero meters is what the bytes say", { skip }, async () => {
  const stored = [
    0,
    1,
    20000,
    20001,
    32768,
    65535,
    ...many(256, () => Math.floor(random() * 65536)),
  ];
  const cases = stored.map((value) => [(value & 255) / 255, (value >> 8) / 255]);
  const results = await gpu!.run({
    wgsl: [shader("decode-height")],
    expression: `vec4<f32>(decodeHeight(a.xy), 0.0, 0.0, 0.0)`,
    cases,
  });
  stored.forEach((value, i) => near(results[i][0], heightMeters(value), 0.02, String(value)));
  assert.equal(heightMeters(ZERO_HEIGHT_BYTES[0] + ZERO_HEIGHT_BYTES[1] * 256), 0);
});

test("packed cache flags read back as they were written", { skip }, async () => {
  const written = [-1, 0, 1, 100, MAX_SUNLIGHT_SLOTS - 1].flatMap((slot) =>
    [false, true].map((baked) => ({ slot, baked })),
  );
  const results = await gpu!.run({
    wgsl: [shader("cache-flags")],
    expression: `vec4<f32>(f32(sunlightSlot(a.x)), select(0.0, 1.0, gradientsBaked(a.x)), 0.0, 0.0)`,
    cases: written.map(({ slot, baked }) => [slot + 1 + (baked ? GRADIENT_READY_BIT : 0)]),
  });
  written.forEach(({ slot, baked }, i) => {
    assert.equal(results[i][0], slot, "slot");
    assert.equal(results[i][1], baked ? 1 : 0, "baked");
  });
});

test(
  "transmittance to the sun agrees away from the sun's disc at the horizon",
  { skip },
  async () => {
    const model = buildAtmosphere(EARTH_AIR, 6_378_137);
    const { bottom, top } = model;
    const halves = Uint16Array.from(model.transmittance, (value) => DataUtils.toHalfFloat(value));
    // The shader softens the horizon over the sun's disc; the table has a hard edge.
    const cases = many(4096, () => [
      Math.fround(bottom + 1 + random() * (top - bottom - 2)),
      Math.fround(random() * 2 - 1),
    ]).filter(([r, mu]) => Math.abs(mu + Math.sqrt(1 - (bottom / r) ** 2)) > 0.006);
    const results = await gpu!.run({
      wgsl: [shader("atmosphere-transmittance")],
      expression: `vec4<f32>(sunTransmittance(lut, lutSampler, ${bottom}.0, ${top}.0, a.x, a.y), 0.0)`,
      cases,
      lut: { width: TRANSMITTANCE_WIDTH, height: TRANSMITTANCE_HEIGHT, halves },
    });
    const expected = new Float64Array(3);
    cases.forEach(([r, mu], i) => {
      model.transmittanceToSun(r, mu, expected);
      for (let c = 0; c < 3; c++) near(results[i][c], expected[c], 0.01, `r ${r} mu ${mu}`);
    });
  },
);

test("the sky-light lookup lands on the table's texel centers", { skip }, async () => {
  const cases = Array.from({ length: SKY_LIGHT_WIDTH }, (_, k) => [
    (2 * k) / (SKY_LIGHT_WIDTH - 1) - 1,
  ]);
  const results = await gpu!.run({
    wgsl: [shader("sky-light-u")],
    expression: `vec4<f32>(skyLightU(a.x, ${SKY_LIGHT_WIDTH}.0), 0.0, 0.0, 0.0)`,
    cases,
  });
  results.forEach(([u], k) => near(u * SKY_LIGHT_WIDTH - 0.5, k, 1e-3, `texel ${k}`));
});

test("hapke reflectance agrees with the ISIS curve", { skip }, async () => {
  const cases = many(1024, () => {
    const incidence = random() * 1.65,
      emission = random() * 1.65,
      azimuth = random() * 6.28;
    return [
      Math.sin(incidence),
      0,
      Math.cos(incidence),
      0,
      Math.sin(emission) * Math.cos(azimuth),
      Math.sin(emission) * Math.sin(azimuth),
      Math.cos(emission),
      0,
    ].map(Math.fround);
  });
  const results = await gpu!.run({
    wgsl: [shader("hapke")],
    expression: `vec4<f32>(hapkeReflectance(vec3<f32>(0.0, 0.0, 1.0), a.xyz, b.xyz,
      vec4<f32>(${W}, ${G}, ${B0}.0, ${H}), ${hapkeReference([W, G, B0, H])}), 0.0, 0.0, 0.0)`,
    cases,
  });
  cases.forEach((c, i) => {
    const phase = c[0] * c[4] + c[1] * c[5] + c[2] * c[6];
    near(results[i][0], reflectance(c[2], c[6], phase, 20), 2e-3, c.join(","));
  });
  const [nadir] = await gpu!.run({
    wgsl: [shader("hapke")],
    expression: `vec4<f32>(hapkeReflectance(a.xyz, a.xyz, a.xyz,
      vec4<f32>(${W}, ${G}, ${B0}.0, ${H}), ${hapkeReference([W, G, B0, H])}), 0.0, 0.0, 0.0)`,
    cases: [[0, 0, 1]],
  });
  near(nadir[0], 1, 1e-4, "overhead full sun stays at unit brightness");
});

test("close-up grain fades in as imagery runs out of texels", { skip }, async () => {
  const cases = [[2], [1.6], [0.55], [0.5], [0]];
  const results = await gpu!.run({
    wgsl: [shader("surface-detail")],
    expression: `vec4<f32>(detailWeight(a.x), 0.0, 0.0, 0.0)`,
    cases,
  });
  assert.deepEqual(
    results.map(([weight]) => weight),
    [0, 0, 1, 1, 0],
  );
});

test("night lights are emissive and fade across the terminator", { skip }, async () => {
  const sunlit = [1, 0, 0],
    midpoint = -0.05;
  const cases = [-1, midpoint, 1].map((cosine) => [
    cosine,
    Math.sqrt(1 - cosine * cosine),
    0,
    0,
    ...sunlit,
    0,
  ]);
  const results = await gpu!.run({
    wgsl: [shader("night-lights")],
    expression: `vec4<f32>(addNightLights(vec3<f32>(0.25), vec3<f32>(1.0), a.xyz, b.xyz, 1.0), 0.0)`,
    cases,
  });
  near(results[0][0], 1.25, 1e-6, "deep night adds all of the lights to the day colour");
  near(results[1][0], 0.75, 1e-5, "half way through the terminator");
  near(results[2][0], 0.25, 1e-6, "daylight has none");
});

test("the daylight floor obeys surface orientation and occlusion", { skip }, async () => {
  const table = [
    [0, -0.1, 1, 0],
    [0, 0, 1, 0],
    [0, 1, 1, 0.24],
    [1, 1, 1, 1],
    [1, 1, 0, 0],
    [0, 1, 0, 0],
    [0, 1, 0.5, 0.12],
  ];
  const results = await gpu!.run({
    wgsl: [shader("solar-visibility")],
    expression: `vec4<f32>(shadowedShade(a.x, a.y, a.z), 0.0, 0.0, 0.0)`,
    cases: table,
  });
  table.forEach((row, i) => near(results[i][0], row[3], 1e-6, row.join(",")));
});
