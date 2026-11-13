// This library against the dataset contract's conformance files. tests/contract is a copy of
// tile-service's spec/conformance: refresh it from there when the contract changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHeightTiles, heightMeters } from "../src/elevation/tiles.ts";
import { parseImageryManifest } from "../src/imagery/manifest.ts";
import { parseRegionalCatalog } from "../src/imagery/regions.ts";
import { rootDirection, rootMaxLevel, rootUV } from "../src/tiles/roots.ts";

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`contract/${name}.json`, import.meta.url), "utf8"));
const grid = read("grid");
const cases = read("documents");
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const radians = Math.PI / 180;
const direction = (latitude: number, longitude: number) => [
  Math.cos(latitude * radians) * Math.cos(longitude * radians),
  Math.sin(latitude * radians),
  -Math.cos(latitude * radians) * Math.sin(longitude * radians),
];

test("positions match the contract", () => {
  const actual = new Float64Array(3);
  for (const { root, u, v, latitude, longitude } of grid.points) {
    rootDirection(root, u, v, actual);
    direction(latitude, longitude).forEach((value, axis) => close(actual[axis], value));
    if (root < 2 && (u === 0 || u === 1 || v === 0 || v === 1)) continue;
    const [x, y, z] = direction(latitude, longitude);
    const [backU, backV] = rootUV(root, x, y, z);
    close(backU, u);
    close(backV, v);
  }
});

test("levels match the contract", () => {
  for (const { root, maxLevel, rootMaxLevel: expected } of grid.levels)
    assert.equal(rootMaxLevel(root, maxLevel), expected);
});

test("heights match the contract", () => {
  for (const { stored, scaleMeters, offsetMeters, meters } of grid.heights)
    close(heightMeters(stored, { scaleMeters, offsetMeters }), meters);
});

for (const { name, type, document, base, valid } of cases) {
  test(name, () => {
    const parse = () =>
      type === "regions"
        ? parseRegionalCatalog(document, base)
        : type === "heights"
          ? parseHeightTiles(document)
          : parseImageryManifest(document);
    if (valid) parse();
    else assert.throws(parse);
  });
}
