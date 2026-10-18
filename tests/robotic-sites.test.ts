import assert from "node:assert/strict";
import test from "node:test";
import { ROBOTIC_LANDING_SITES } from "../examples/moon/data/robotic-sites.ts";
import { LUNAR_PLACES } from "../examples/moon/data/landmarks.ts";

test("robotic sites have unique names, signed east coordinates, provenance and uncertainty", () => {
  assert.equal(new Set(LUNAR_PLACES.map((site) => site.name)).size, LUNAR_PLACES.length);
  for (const site of ROBOTIC_LANDING_SITES) {
    assert.ok(Number.isFinite(site.latitudeDeg) && Math.abs(site.latitudeDeg) <= 90);
    assert.ok(Number.isFinite(site.longitudeDeg) && Math.abs(site.longitudeDeg) <= 180);
    assert.ok(site.sourceUrl?.startsWith("https://"));
    if (site.accuracy !== "localized") assert.match(site.detail!, /location/);
    if (site.outcome === "crashed") assert.equal(site.kind, "impact");
  }
  const blueGhost = ROBOTIC_LANDING_SITES.find((site) => site.name === "Blue Ghost 1")!;
  assert.deepEqual([blueGhost.latitudeDeg, blueGhost.longitudeDeg], [18.562, 61.81]);
  const change6 = ROBOTIC_LANDING_SITES.find((site) => site.name === "Chang’e 6")!;
  assert.deepEqual([change6.latitudeDeg, change6.longitudeDeg], [-41.6385, -153.9852]);
  assert.equal(
    ROBOTIC_LANDING_SITES.find((site) => site.name === "Surveyor 4")!.accuracy,
    "unconfirmed",
  );
});
