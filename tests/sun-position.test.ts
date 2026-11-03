import assert from "node:assert/strict";
import test from "node:test";
import { icrfToBodyFixed } from "../src/frames.ts";
import { subsolarPoint } from "../src/sun-position.ts";

test("J2000 to ITRF agrees with Vallado's FK5 example to about a kilometer", () => {
  // Example 3-15: nutation, polar motion and UT1−UTC are omitted here.
  const time = Date.UTC(2004, 3, 6, 7, 51, 28, 386.009);
  const v = new Float64Array([5102.508958, 6123.011401, 6378.136928]);
  icrfToBodyFixed("EARTH")(time, v);
  const expected = [-1033.479383, 7901.2952754, 6380.3565958];
  const error = Math.hypot(v[0] - expected[0], v[1] - expected[1], v[2] - expected[2]);
  assert.ok(error < 1.5, `error ${error} km`);
});

test("IAU Moon and Mars frames use the published poles and rotation rates", () => {
  const J2000 = Date.UTC(2000, 0, 1, 12) - 69_184;
  for (const [center, alpha, delta, rate] of [
    ["MOON", 269.9949, 66.5392, 13.17635815],
    ["MARS", 317.68143, 52.8865, 350.89198226],
  ] as const) {
    const transform = icrfToBodyFixed(center);
    const a = (alpha * Math.PI) / 180,
      d = (delta * Math.PI) / 180;
    // The Moon's pole wobbles by ~4° through its periodic terms; Mars has none.
    const tolerance = center === "MOON" ? 0.08 : 1e-9;
    const pole = new Float64Array([
      Math.cos(d) * Math.cos(a),
      Math.cos(d) * Math.sin(a),
      Math.sin(d),
    ]);
    transform(J2000, pole);
    assert.ok(pole[2] >= Math.cos(tolerance), `${center} pole ${pole[2]}`);
    // A body-fixed meridian returns after one sidereal day.
    const sidereal = (360 / rate) * 86_400_000;
    const later = new Float64Array([1, 0, 0]),
      now = new Float64Array([1, 0, 0]);
    transform(J2000 + 10 * sidereal, now);
    transform(J2000 + 11 * sidereal, later);
    const drift = Math.acos(Math.min(1, now[0] * later[0] + now[1] * later[1] + now[2] * later[2]));
    assert.ok(drift < (center === "MOON" ? 0.01 : 1e-6), `${center} drift ${drift}`);
  }
  assert.throws(() => icrfToBodyFixed("JUPITER"), /No body-fixed frame/);
});

test("subsolar points match equinoxes and solstices on Earth and Mars", () => {
  const near = (actual: number, expected: number, tolerance: number) =>
    assert.ok(Math.abs(actual - expected) < tolerance, `${actual} vs ${expected}`);
  // 2026 March equinox, 14:46 UTC; the equation of time is −7.4 minutes.
  const equinox = subsolarPoint("Earth", Date.UTC(2026, 2, 20, 14, 46));
  near(equinox.latitudeDeg, 0, 0.02);
  near(equinox.longitudeDeg, -15 * (14 + 46 / 60 - 7.4 / 60 - 12), 0.15);
  near(subsolarPoint("Earth", Date.UTC(2026, 5, 21, 8, 24)).latitudeDeg, 23.436, 0.01);
  near(subsolarPoint("EARTH", Date.UTC(2026, 11, 21, 20, 50)).latitudeDeg, -23.436, 0.01);
  // Mars year 38 began (Ls 0) on 2024-11-12; Ls 90 followed on 2025-05-29.
  near(subsolarPoint("Mars", Date.UTC(2024, 10, 12)).latitudeDeg, 0, 0.3);
  near(subsolarPoint("Mars", Date.UTC(2025, 4, 29)).latitudeDeg, 25.19, 0.1);
  // The Moon's equator is within 1.54° of the ecliptic.
  for (let day = 0; day < 400; day += 13)
    assert.ok(
      Math.abs(subsolarPoint("Moon", Date.UTC(2026, 0, 1) + day * 86_400_000).latitudeDeg) < 1.7,
    );
  assert.throws(() => subsolarPoint("Venus", 0), /No solar ephemeris/);
});
