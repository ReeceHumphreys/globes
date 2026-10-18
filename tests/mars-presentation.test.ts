import test from "node:test";
import assert from "node:assert/strict";
import {
  MARS_DUST_PRESETS,
  MARS_EXPOSURE_STOPS,
  MARS_VIEWS,
  marsSunForView,
  marsDustPreset,
} from "../examples/planets/mars-presentation.ts";
import { sunDirection } from "../src/rendering/sun.ts";

test("Mars display exposure compensates reduced sunlight without modifying the atmosphere", () => {
  assert.ok(MARS_EXPOSURE_STOPS > 1.5 && MARS_EXPOSURE_STOPS < 1.7);
  assert.ok(Math.abs((586.2 / 1361) * 2 ** MARS_EXPOSURE_STOPS - 2 ** 0.35) < 1e-12);
  assert.equal(marsDustPreset(null), "clear");
  assert.equal(marsDustPreset("invalid"), "clear");
  assert.equal(marsDustPreset("dusty"), "dusty");
  assert.ok(MARS_DUST_PRESETS.clear.opticalDepth < MARS_DUST_PRESETS.dusty.opticalDepth);
  assert.ok(MARS_DUST_PRESETS.dusty.opticalDepth < MARS_DUST_PRESETS.thick.opticalDepth);
});

test("Mars feature views remain above terrain and on the illuminated hemisphere", () => {
  const rad = Math.PI / 180;
  for (const view of Object.values(MARS_VIEWS)) {
    assert.ok(Math.abs(view.latitude) <= 90 && Math.abs(view.longitude) <= 180);
    assert.ok(view.altitude > 100_000);
    const direction = sunDirection(view.longitude * rad, view.latitude * rad);
    const sunPosition = marsSunForView(view);
    const sun = sunDirection(sunPosition.longitude * rad, sunPosition.latitude * rad);
    assert.ok(direction.reduce((sum, value, i) => sum + value * sun[i], 0) > 0.3);
  }
  const orbit = MARS_VIEWS.orbit;
  const sun = marsSunForView(orbit);
  assert.equal(sun.longitude - orbit.longitude, 70);
});
