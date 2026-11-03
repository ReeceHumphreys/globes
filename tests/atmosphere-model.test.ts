import assert from "node:assert/strict";
import test from "node:test";
import {
  EARTH_AIR,
  MARS_AIR,
  buildAtmosphere,
  marsAir,
  miePhase,
  rayleighPhase,
  SKY_LIGHT_WIDTH,
} from "../src/atmosphere/model.ts";

const EARTH = 6_378_137;

test("zenith transmittance matches the analytic vertical optical depth", () => {
  const model = buildAtmosphere(EARTH_AIR, EARTH);
  const out = model.transmittanceToSun(EARTH, 1, new Float64Array(3));
  const { rayleigh, mie, absorption } = EARTH_AIR;
  for (let c = 0; c < 3; c++) {
    // ∫ exp(-h/H) dh over the atmosphere, plus the ozone tent's area (width / 2).
    const column = (H: number) => H * -Math.expm1(-EARTH_AIR.height / H);
    const tau =
      rayleigh.scattering[c] * column(rayleigh.scaleHeight) +
      mie.extinction[c] * column(mie.scaleHeight) +
      absorption!.extinction[c] * (absorption!.width / 2);
    assert.ok(
      Math.abs(out[c] - Math.exp(-tau)) < 2e-3,
      `channel ${c}: ${out[c]} vs ${Math.exp(-tau)}`,
    );
  }
  // Blue scatters most: the noon sun is slightly yellow.
  assert.ok(out[2] < out[1] && out[1] < out[0]);
});

test("light reaching the ground reddens toward the horizon and vanishes below it", () => {
  const model = buildAtmosphere(EARTH_AIR, EARTH);
  const zenith = model.transmittanceToSun(EARTH, 1, new Float64Array(3));
  const low = model.transmittanceToSun(EARTH, 0.05, new Float64Array(3));
  assert.ok(low[2] < zenith[2] * 0.2, "low sun loses most of its blue");
  assert.ok(low[0] / low[2] > zenith[0] / zenith[2], "and turns redder");
  assert.deepEqual([...model.transmittanceToSun(EARTH, -0.2, new Float64Array(3))], [0, 0, 0]);
  // Looking up from 400 km there is only a trace of air left.
  const space = model.transmittanceToSun(EARTH + 400_000, 1, new Float64Array(3));
  assert.ok(space.every((x) => x > 0.9999));
});

test("sky light on the ground is blue, grows with sun height, and is dark at night", () => {
  const model = buildAtmosphere(EARTH_AIR, EARTH);
  const at = (mu: number) => {
    const k = Math.round(((mu + 1) / 2) * (SKY_LIGHT_WIDTH - 1)) * 4;
    return [...model.skyLight.slice(k, k + 3)];
  };
  const noon = at(1),
    morning = at(0.3),
    night = at(-0.5);
  assert.ok(noon[2] > noon[0], "skylight is bluer than red");
  assert.ok(noon[1] > morning[1], "brighter when the sun is high");
  assert.ok(night.every((x) => x < 1e-6));
  // Single scattering gives about 4% of the direct sun on a level surface. Real clear
  // skies give 10–15%; the rest is light scattered more than once, which this omits.
  assert.ok(noon[1] > 0.03 && noon[1] < 0.3, `noon sky light ${noon[1]}`);
});

test("phase functions are normalized over the sphere", () => {
  for (const phase of [rayleighPhase, (nu: number) => miePhase(nu, 0.8)]) {
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const nu = -1 + (2 * (i + 0.5)) / n;
      sum += phase(nu) * 2 * Math.PI * (2 / n);
    }
    assert.ok(Math.abs(sum - 1) < 1e-3, `integral ${sum}`);
  }
});

test("the Mars preset is a thin, dusty atmosphere with the requested optical depth", () => {
  const model = buildAtmosphere(MARS_AIR, 3_396_190);
  const zenith = model.transmittanceToSun(model.bottom, 1, new Float64Array(3));
  assert.ok(Math.abs(-Math.log(zenith[1]) - 0.2) < 0.01, "green vertical optical depth ≈ 0.2");
  assert.ok(MARS_AIR.intensity < 0.5);
  assert.throws(() => marsAir(-1), RangeError);
});
