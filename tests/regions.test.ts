import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseRegionalCatalog } from "../src/imagery/regions.ts";
import { APOLLO_LANDING_SITES } from "../examples/moon/data/landing-sites.ts";
const base = {
  body: "Moon",
  id: "global",
  radiusMeters: 1737400,
  maxLevel: 7,
  tileSize: 256,
  gutter: 2,
};
const catalog = {
  version: 1,
  body: "Moon",
  radiusMeters: 1737400,
  baseId: "global",
  baseMaxLevel: 7,
  tileSize: 256,
  gutter: 2,
  sites: [
    {
      id: "apollo11",
      name: "Apollo 11",
      latitudeDeg: 0.67,
      longitudeDeg: 23.47,
      radiusMeters: 2000,
      maxLevel: 9,
      source: {
        sourcePage: "https://example.test/source",
        credit: "LROC",
        nativeResolutionMeters: 0.5,
      },
      tiles: ["0/8/150/130", "0/9/300/260"],
    },
  ],
};
test("regional catalog validates base compatibility, numeric addresses and full ancestor chains", () => {
  assert.equal(parseRegionalCatalog(catalog, base), catalog);
  for (const patch of [{ baseId: "other" }, { tileSize: 512 }, { baseMaxLevel: 8 }, { gutter: 1 }])
    assert.throws(() => parseRegionalCatalog({ ...catalog, ...patch }, base));
  for (const tiles of [
    ["../source"],
    ["0/9/300/260"],
    ["0/8/256/130"],
    ["0/7/50/50"],
    ["0/8/150/130", "0/8/150/130"],
  ])
    assert.throws(() =>
      parseRegionalCatalog({ ...catalog, sites: [{ ...catalog.sites[0], tiles }] }, base),
    );
  assert.throws(
    () =>
      parseRegionalCatalog(
        { ...catalog, sites: [catalog.sites[0], { ...catalog.sites[0], id: "other" }] },
        base,
      ),
    /overlapping/,
  );
});
test("download catalog includes every existing Apollo label and explicit native resolution/integrity metadata", () => {
  const sources = JSON.parse(
    fs.readFileSync("../tile-service/datasets/apollo-nac.json", "utf8"),
  ).sites;
  assert.deepEqual(
    sources.map((s) => s.name).sort(),
    APOLLO_LANDING_SITES.map((s) => s.name).sort(),
  );
  for (const s of sources) {
    assert.ok(s.sourceUrl.startsWith("https://pds.lroc.im-ldi.com/"));
    assert.ok(s.sourcePage.startsWith("https://data.lroc.im-ldi.com/"));
    assert.ok(s.expectedBytes > 0);
    assert.match(s.sourceETag, /^"[a-f0-9]+"$/);
    assert.ok(s.nativeResolutionMeters > 0 && s.nativeResolutionMeters <= 1.2);
  }
});
