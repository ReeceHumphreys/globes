import test from "node:test";
import assert from "node:assert/strict";
import { planCoverage } from "../src/tiles/coverage.ts";
import { SHACKLETON } from "../examples/moon/data/landmarks.ts";
const detail = { ...SHACKLETON, radiusMeters: 16000, maxLevel: 13 };
const overview = { latitudeDeg: -90, longitudeDeg: 0, radiusMeters: 44000, maxLevel: 11 };
test("polar coverage has unique complete ancestors, broad context and bounded fine detail", () => {
  const addresses = planCoverage(1_737_400, detail, overview, 8),
    keys = new Set(addresses.map((a) => `${a.face}/${a.level}/${a.x}/${a.y}`));
  assert.equal(keys.size, addresses.length);
  assert.ok(addresses.length > 8005 && addresses.length < 20000);
  assert.ok(addresses.every((a) => a.face === 3));
  for (const a of addresses)
    if (a.level > 8) assert.ok(keys.has(`3/${a.level - 1}/${a.x >> 1}/${a.y >> 1}`));
  const old = planCoverage(1_737_400, detail, undefined, 8);
  assert.equal(
    addresses.filter((a) => a.level === 13).length,
    old.filter((a) => a.level === 13).length,
    "context does not multiply the finest tiles",
  );
  assert.ok(
    addresses.filter((a) => a.level === 11).length > old.filter((a) => a.level === 11).length,
  );
});
test("polar planning rejects unsupported settings before starting downloads", () => {
  assert.throws(() => planCoverage(1_737_400, { ...detail, maxLevel: 16 }, overview), /20,000/);
  assert.throws(
    () => planCoverage(1_737_400, detail, { ...overview, radiusMeters: 10000 }),
    /contain/,
  );
  assert.throws(() => planCoverage(1_737_400, detail, { ...overview, maxLevel: 14 }), /lower/);
  assert.throws(() => planCoverage(1_737_400, { ...detail, latitudeDeg: NaN }), /Invalid/);
});
