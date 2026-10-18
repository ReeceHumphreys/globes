import assert from "node:assert/strict";
import test from "node:test";
import { validateBody, matchesBody } from "../src/body.ts";
import { planCoverage } from "../src/tiles/coverage.ts";

test("body validation accepts spherical bodies and rejects mismatched datasets", () => {
  for (const body of [
    { name: "Moon", radiusMeters: 1737400 },
    { name: "Mars", radiusMeters: 3389500 },
    { name: "Earth", radiusMeters: 6371000 },
  ]) {
    validateBody(body);
    assert.ok(matchesBody({ body: body.name, radiusMeters: body.radiusMeters }, body));
    assert.ok(!matchesBody({ body: body.name, radiusMeters: body.radiusMeters + 1000 }, body));
    assert.ok(!matchesBody({ body: "another", radiusMeters: body.radiusMeters }, body));
  }
  for (const radiusMeters of [0, -1, Infinity, NaN])
    assert.throws(() => validateBody({ name: "body", radiusMeters }));
  assert.throws(() => validateBody({ name: "", radiusMeters: 1 }));
});
test("offline coverage scales physical tile extent with the configured body radius", () => {
  const detail = { latitudeDeg: -89.67, longitudeDeg: 129.78, radiusMeters: 16000, maxLevel: 10 };
  const moon = planCoverage(1737400, detail),
    mars = planCoverage(3389500, detail);
  assert.ok(moon.length > mars.length);
  assert.throws(() => planCoverage(0, detail));
});
