import assert from "node:assert/strict";
import test from "node:test";
import { Object3D, Vector3 } from "three/webgpu";
import { TerrainMask } from "../src/terrain-mask.ts";
import { placeChildren, type PlacementGlobe } from "../src/placement.ts";
import { geographicToDirection } from "../src/geographic.ts";

const radius = 1000;
const globe = Object.assign(new Object3D(), {
  heightAt: () => 0,
  positionAt: (lat: number, lon: number, alt: number, target: Vector3) =>
    geographicToDirection(lat, lon, target).multiplyScalar(radius + alt),
}) as PlacementGlobe;

test("a mask is placed like an anchor, and its rectangle turns with heading", () => {
  const mask = new TerrainMask(0, 0, { width: 40, length: 100, heading: 90 });
  globe.add(mask);
  placeChildren(globe, new Vector3(2 * radius, 0, 0), new Vector3(-1, 0, 0));
  assert.ok(mask.position.distanceTo(new Vector3(radius, 0, 0)) < 1e-9);
  const across = new Vector3(),
    along = new Vector3();
  mask.axes(across, along);
  // At (0, 0), east is -z and north is +y. Heading 90° points the length east.
  assert.ok(along.distanceTo(new Vector3(0, 0, -1)) < 1e-9, `along ${along.toArray()}`);
  assert.ok(across.distanceTo(new Vector3(0, -1, 0)) < 1e-9, `across ${across.toArray()}`);
  mask.heading = 0;
  mask.axes(across, along);
  assert.ok(along.distanceTo(new Vector3(0, 1, 0)) < 1e-9);
  assert.throws(() => new TerrainMask(0, 0, { width: 0, length: 1 }), RangeError);
});
