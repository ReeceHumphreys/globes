import assert from "node:assert/strict";
import test from "node:test";
import { createTileBatch, TILE_BYTES } from "../src/tiles/tile.ts";
import { ROOT_COUNT } from "../src/tiles/roots.ts";
import { createSelectionView, VIEW } from "../src/tiles/lod.ts";
import { createResidentTiles } from "../src/tiles/resident-tiles.ts";
import { tileColor } from "../src/rendering/tile-colors.ts";
import {
  createTileInstances,
  writeTileInstances,
  INSTANCE_BYTES,
} from "../src/rendering/tile-instances.ts";

const radius = 1_737_400;

test("a tile that keeps failing reaches onError once, with its cause", async () => {
  const errors: Error[] = [];
  const tiles = createResidentTiles({
    slots: 6,
    label: "Test",
    maxLevel: () => 0,
    available: () => true,
    load: async () => {
      throw new Error("offline");
    },
    store: () => ({}),
    onChange() {},
    onError: (error) => errors.push(error as Error),
  });
  const instances = createTileInstances(1);
  instances.count = 1;
  instances.rootUVs.set([0, 0, 1]);
  tiles.plan(instances, [1]);
  tiles.pump();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(errors.length, 4, "one for each root, after its retries");
  assert.match(errors[0].message, /Test tile 0\/0\/0\/0 failed/);
  assert.equal((errors[0].cause as Error).message, "offline");
  tiles.dispose();
});
