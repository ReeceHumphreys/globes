import test from "node:test";
import assert from "node:assert/strict";
import { createShadowHeightIndex } from "../src/rendering/shadow-height-index.ts";

function lookup(index, face, level, x, y) {
  let node = face;
  for (let l = 1; l <= level; l++) {
    const shift = level - l,
      q = ((x >> shift) & 1) + 2 * ((y >> shift) & 1);
    node = index.data[node * 8 + q];
    if (node < 0) return undefined;
  }
  return { slot: index.data[node * 8 + 4], blend: index.data[node * 8 + 5] };
}
test("GPU shadow index keeps six roots, sparse deep paths and the same height fades", () => {
  const index = createShadowHeightIndex(64, 20);
  const records = Array.from({ length: 6 }, (_, face) => ({
    face,
    level: 0,
    x: 0,
    y: 0,
    slot: face + 1,
    start: 0,
  }));
  records.push({ face: 3, level: 20, x: 524287, y: 524289, slot: 7, start: 100 });
  index.write(records, 250, 300);
  assert.ok(index.nodeCount() <= 26);
  for (let face = 0; face < 6; face++) assert.equal(lookup(index, face, 0, 0, 0).slot, face + 1);
  assert.equal(lookup(index, 3, 20, 524287, 524289).blend, 0.5);
  assert.equal(lookup(index, 3, 20, 524286, 524289), undefined);
  index.write(records, 400, 300);
  assert.equal(lookup(index, 3, 20, 524287, 524289).blend, 1);
  index.write(records.slice(0, 6), 500, 300);
  assert.equal(index.nodeCount(), 6);
  assert.equal(
    lookup(index, 3, 20, 524287, 524289),
    undefined,
    "evicted slots must not remain reachable",
  );
  assert.equal(index.texture.generateMipmaps, false);
  assert.equal(index.texture.image.data, index.data);
  assert.ok(index.data.byteLength < 100000);
  index.dispose();
});
test("64 independent deep branches stay inside the preallocated shadow index", () => {
  const index = createShadowHeightIndex(64, 20);
  const records = Array.from({ length: 64 }, (_, i) => ({
    face: i % 6,
    level: 20,
    x: (i * 7919) % 1048576,
    y: (i * 65537) % 1048576,
    slot: i + 1,
    start: 0,
  }));
  index.write(records, 0, 0);
  for (const r of records)
    assert.deepEqual(lookup(index, r.face, r.level, r.x, r.y), { slot: r.slot, blend: 1 });
  assert.ok(index.nodeCount() <= 6 + 64 * 20);
  index.dispose();
});

test("stable height index avoids uploads; fades, evictions and slot reuse advance its revision", () => {
  const index = createShadowHeightIndex(6, 4);
  const records = [{ face: 0, level: 0, x: 0, y: 0, slot: 1, start: 0 }];
  index.write(records, 100, 300);
  const revision = index.revision,
    version = index.texture.version;
  index.write(records, 100, 300);
  assert.equal(index.revision, revision);
  assert.equal(index.texture.version, version);
  index.write(records, 150, 300);
  assert.ok(index.revision > revision);
  index.write(records, 500, 300);
  const settled = index.revision;
  index.write(records, 1000, 300);
  assert.equal(index.revision, settled);
  records[0].slot = 2;
  index.write(records, 1000, 300);
  assert.ok(index.revision > settled);
  const reused = index.revision;
  index.write([], 1000, 300);
  assert.ok(index.revision > reused);
  index.dispose();
});
