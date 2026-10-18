import assert from "node:assert/strict";
import test from "node:test";
import { resolveFrame, toScene } from "../src/orbits/frames.ts";
import {
  bodySceneOffset,
  sceneBodyOffset,
  orbitOffset,
  sceneOrbit,
  sceneSolarPosition,
  shownRadius,
} from "../src/orbits/solar-system.ts";

const AU = 149_597_870_700;

function length(v: ArrayLike<number>): number {
  return Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
}

test("Earth, Mars, and the Moon sit at their usual distances", () => {
  const time = Date.UTC(2026, 0, 1);
  const earth = new Float64Array(3);
  const mars = new Float64Array(3);
  const moon = new Float64Array(3);
  const sun = new Float64Array(3);
  sceneSolarPosition("sun", time, sun);
  sceneSolarPosition("earth", time, earth);
  sceneSolarPosition("mars", time, mars);
  sceneSolarPosition("moon", time, moon);
  assert.equal(length(sun), 0);
  assert.ok(Math.abs(length(earth) / AU - 1) < 0.02, `earth ${length(earth) / AU} AU`);
  assert.ok(length(mars) / AU > 1.38 && length(mars) / AU < 1.67, `mars ${length(mars) / AU} AU`);
  let near = Infinity;
  let far = 0;
  for (let day = 0; day < 30; day++) {
    sceneSolarPosition("earth", time + day * 86_400_000, earth);
    sceneSolarPosition("moon", time + day * 86_400_000, moon);
    const distance = Math.hypot(moon[0] - earth[0], moon[1] - earth[1], moon[2] - earth[2]);
    near = Math.min(near, distance);
    far = Math.max(far, distance);
    assert.ok(distance > 340e6 && distance < 420e6, `moon ${distance / 1e3} km`);
  }
  assert.ok(far - near > 20e6, `moon range ${(far - near) / 1e3} km`);
});

test("orbit lines join and cover one revolution", () => {
  const time = Date.UTC(2026, 5, 1);
  for (const body of ["earth", "mars", "moon"] as const) {
    const count = 64;
    const orbit = sceneOrbit(body, time, count);
    const last = orbit.length - 3;
    assert.equal(orbit[0], orbit[last]);
    assert.equal(orbit[1], orbit[last + 1]);
    assert.equal(orbit[2], orbit[last + 2]);
    const scale = body === "moon" ? 384e6 : length(orbit);
    const prev = (count - 1) * 3;
    const step = Math.hypot(
      orbit[0] - orbit[prev],
      orbit[1] - orbit[prev + 1],
      orbit[2] - orbit[prev + 2],
    );
    assert.ok(step / scale < 0.2, `${body} step ${step / scale}`);
    const mid = (count / 2) * 3;
    assert.ok(
      Math.hypot(orbit[0] - orbit[mid], orbit[1] - orbit[mid + 1], orbit[2] - orbit[mid + 2]) >
        scale * 0.5,
    );
  }
});

test("a distant body keeps a minimum size until the true radius is larger", () => {
  const earth = 6_378_137;
  assert.ok(shownRadius(earth, AU) > earth * 10);
  assert.equal(shownRadius(earth, earth * 3), earth);
});

test("orbit offset uses +Z at yaw 0, +X at a quarter turn, and +Y at pitch up", () => {
  const out = new Float64Array(3);
  orbitOffset(0, 0, 10, out);
  assert.deepEqual(Array.from(out), [0, 0, 10]);
  orbitOffset(Math.PI / 2, 0, 10, out);
  assert.ok(Math.abs(out[0] - 10) < 1e-12 && Math.abs(out[1]) < 1e-12 && Math.abs(out[2]) < 1e-12);
  orbitOffset(0, Math.PI / 2, 10, out);
  assert.ok(Math.abs(out[0]) < 1e-12 && Math.abs(out[1] - 10) < 1e-12 && Math.abs(out[2]) < 1e-12);
});

test("an inertial scene offset matches the body frame", () => {
  const time = Date.UTC(2004, 3, 6, 7, 51, 28, 386);
  const icrf = new Float64Array([5102.509, 6123.011, 6378.137]);
  const scene = new Float64Array(3);
  toScene(icrf, scene);
  const got = new Float64Array(3);
  bodySceneOffset("earth", time, scene, got);
  const fixed = new Float64Array(icrf);
  resolveFrame("EARTH", "ICRF")(time, fixed);
  const expected = new Float64Array(3);
  toScene(fixed, expected);
  assert.ok(Math.hypot(got[0] - expected[0], got[1] - expected[1], got[2] - expected[2]) < 1e-6);
});

test("a body-fixed camera offset round-trips to the inertial scene", () => {
  const time = Date.UTC(2026, 0, 1);
  const inertial = new Float64Array([1.2e7, -4e6, 8e6]);
  const fixed = new Float64Array(3);
  const back = new Float64Array(3);
  for (const body of ["earth", "moon", "mars"] as const) {
    bodySceneOffset(body, time, inertial, fixed);
    sceneBodyOffset(body, time, fixed, back);
    assert.ok(Math.hypot(back[0] - inertial[0], back[1] - inertial[1], back[2] - inertial[2]) < 1);
    sceneBodyOffset(body, time, inertial, fixed);
    bodySceneOffset(body, time, fixed, back);
    assert.ok(Math.hypot(back[0] - inertial[0], back[1] - inertial[1], back[2] - inertial[2]) < 1);
  }
});
