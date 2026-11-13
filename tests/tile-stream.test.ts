import assert from "node:assert/strict";
import test from "node:test";
import { createTileStream } from "../src/tiles/tile-stream.ts";
import { PAIR } from "../src/rendering/binding-row.ts";
import { createTileBatch } from "../src/tiles/tile.ts";
import { createTileInstances, writeTileInstances } from "../src/rendering/tile-instances.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function rootTile(root: number) {
  const batch = createTileBatch(1);
  batch.count = 1;
  batch.root[0] = root;
  const instances = createTileInstances(1);
  writeTileInstances(batch, instances, 1000);
  return instances;
}

test("a stream uploads tiles into slots, fades them in, and settles", async () => {
  const width = 16 + 2 * 2,
    bad = new Set([1]);
  const stream = createTileStream<number>({
    tileSize: 16,
    gutter: 2,
    texels: "height",
    empty: [7, 9],
    stride: 12,
    capacity: 1,
    slots: 8,
    label: "Test",
    fadeMs: 100,
    maxLevel: () => 0,
    available: () => true,
    // A root in `bad` returns a tile of the wrong size, which counts as a failed load.
    load: async ({ root }) => root,
    bytes: (root) => new Uint8Array(bad.has(root) ? 3 : width * width * 2).fill(root),
    onChange() {},
    onError() {},
  });
  assert.deepEqual([...stream.texture.image.data.subarray(0, 4)], [7, 9, 7, 9], "empty layer");
  const view = (now: number) => ({
    clipFromRelative: new Float32Array(16),
    projectionScale: 1,
    now,
  });
  const good = rootTile(0);
  stream.plan(good, view(0));
  stream.write(good);
  stream.pump();
  assert.equal(stream.settled(), false);
  await tick();
  await tick();
  stream.plan(good, view(0));
  stream.write(good);
  assert.ok(stream.bindings.data[PAIR.layers] > 0, "bound to a slot");
  // Every root is always wanted; the three good ones load.
  assert.equal(stream.revision, 3);
  assert.ok(stream.needsFrame(), "fading");
  stream.plan(good, view(200));
  stream.write(good);
  assert.equal(stream.bindings.data[PAIR.blend], 1);
  assert.ok(stream.settled());

  const broken = rootTile(1);
  for (let i = 0; i < 4; i++) {
    stream.plan(broken, view(300));
    stream.write(broken);
    stream.pump();
    await tick();
    await tick();
  }
  assert.ok(stream.settled(), "a failed tile does not hold up settling");
  assert.equal(stream.revision, 3, "nothing of the wrong size was stored");
  stream.dispose();
});
