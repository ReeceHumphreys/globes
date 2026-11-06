import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { parseHeightTiles, decodeHeightTile, sampleTile } from "../src/elevation/tiles.ts";
import { createHeightTileCache } from "../src/elevation/tile-cache.ts";
import { HEIGHT_STRIDE } from "../src/rendering/binding-row.ts";
import { createTileBatch } from "../src/tiles/tile.ts";
import { createTileInstances, writeTileInstances } from "../src/rendering/tile-instances.ts";
const width = 20;
function bytes(height) {
  const data = new Uint8Array(width * width * 2),
    view = new DataView(data.buffer);
  for (let i = 0; i < width * width; i++) view.setUint16(i * 2, (height + 10000) * 2, true);
  return data;
}
function info(key, height, lower = height, upper = height) {
  return {
    path: `base/${key}.u16`,
    min: height,
    max: height,
    lower,
    upper,
    sha256: createHash("sha256").update(bytes(height)).digest("hex"),
  };
}
function fixture() {
  const tiles = {};
  for (let f = 0; f < 6; f++)
    tiles[`${f}/0/0/0`] = info(`${f}/0/0/0`, 1000, 1000, f === 0 ? 2000 : 1000);
  tiles["0/1/1/1"] = info("0/1/1/1", 2000);
  return parseHeightTiles({
    version: 1,
    body: "Moon",
    radiusMeters: 1737400,
    projection: "normalized-cube",
    format: "uint16-le",
    scaleMeters: 0.5,
    offsetMeters: -10000,
    tileSize: 16,
    gutter: 2,
    maxLevel: 1,
    minMeters: 1000,
    maxMeters: 2000,
    tiles,
    sources: [],
  });
}
function terrain() {
  const tiles = createTileBatch(1);
  tiles.count = 1;
  tiles.face[0] = 0;
  tiles.level[0] = 2;
  tiles.x[0] = tiles.y[0] = 2;
  const instances = createTileInstances(1);
  writeTileInstances(tiles, instances, 1737400, 1738400, 0.1, -0.1);
  return instances;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const view = (now) => ({
  now,
  clipFromRelative: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  projectionScale: 800,
});

test("numeric height catalogs reject unsafe addresses, missing parents and nonconservative bounds", () => {
  const m = fixture();
  assert.throws(() => parseHeightTiles({ ...m, gutter: 1 }));
  const copy = structuredClone(m);
  copy.tiles["0/0/0/0"].upper = 1000;
  assert.throws(() => parseHeightTiles(copy), /hierarchy/);
  const bad = structuredClone(m);
  bad.tiles["0/1/1/1"].path = "../escape.u16";
  assert.throws(() => parseHeightTiles(bad));
  assert.throws(() => decodeHeightTile(new Uint8Array(1), m.tiles["0/0/0/0"], width));
  assert.throws(() => decodeHeightTile(bytes(1001), m.tiles["0/0/0/0"], width), /range/);
});

test("CPU clearance and GPU bindings share parent/fine height fades with no unbounded requests", async () => {
  const requests = [];
  const cache = createHeightTileCache(
    fixture(),
    "https://example.test/heights/manifest.json",
    1,
    () => {},
    (url, signal) =>
      new Promise((resolve, reject) =>
        requests.push({ url, signal, resolve, reject, done: false }),
      ),
    8,
    { fadeMs: 100 },
  );
  const instances = terrain();
  try {
    cache.update(instances, view(0));
    assert.equal(requests.length, 4);
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 0);
    async function resolveRoots() {
      for (let round = 0; round < 6; round++) {
        for (const r of requests)
          if (!r.done && r.url.includes("/0/0/0.u16")) {
            r.done = true;
            r.resolve(bytes(1000));
          }
        await tick();
      }
    }
    await resolveRoots();
    cache.update(instances, view(0));
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 0);
    cache.update(instances, view(100));
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 1000);
    const child = requests.find((r) => r.url.endsWith("/0/1/1/1.u16"));
    assert.ok(child);
    child.done = true;
    child.resolve(bytes(2000));
    await tick();
    cache.update(instances, view(100));
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 1000);
    cache.update(instances, view(150));
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 1500);
    assert.equal(cache.bindings.data[10], 0.5);
    const data = cache.bindings.data,
      slot = data[0],
      parent = data[1];
    assert.ok(slot > 0 && parent > 0 && slot !== parent);
    const image = cache.texture.image.data,
      layerBytes = width * width * 2;
    const gridFor = (index) => {
      const buffer = image.slice(index * layerBytes, (index + 1) * layerBytes);
      return new Uint16Array(buffer.buffer);
    };
    const uv = [0.4, 0.4],
      fine = sampleTile(
        gridFor(slot),
        width,
        (data[2] + uv[0] * data[4]) * width - 0.5,
        (data[3] + uv[1] * data[5]) * width - 0.5,
      ),
      coarse = sampleTile(
        gridFor(parent),
        width,
        (data[6] + uv[0] * data[8]) * width - 0.5,
        (data[7] + uv[1] * data[9]) * width - 0.5,
      );
    assert.equal(coarse * (1 - data[10]) + fine * data[10], cache.sampleDirection(1, 0.2, -0.2));
    cache.update(instances, view(200));
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 2000);
    assert.equal(cache.needsFrame(), false);
    assert.ok(cache.stats().resident <= 8);
    assert.ok(cache.stats().wanted <= 8);
    const range = new Float64Array(2);
    cache.rangeForTile(0, 10, 600, 600, range);
    assert.ok(range[0] <= 2000 && range[1] >= 2000);
    assert.ok(range[1] - range[0] <= 1.01, "deep loaded bounds remain tight");
    assert.equal(cache.bindings.data.length, HEIGHT_STRIDE);
  } finally {
    cache.dispose();
  }
});

test("failed or corrupt fine heights leave coarse geometry available; disposal aborts work", async () => {
  let bad = 0;
  const cache = createHeightTileCache(
    fixture(),
    "https://example.test/heights/manifest.json",
    1,
    () => {},
    async (url) => {
      if (!url.includes("/1/1/1.u16")) return bytes(1000);
      bad++;
      return bytes(1999);
    },
    8,
    { fadeMs: 0 },
  );
  const instances = terrain();
  try {
    cache.update(instances, view(0));
    for (let i = 0; i < 12; i++) {
      await tick();
      cache.update(instances, view(i));
    }
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 1000);
    assert.equal(bad, 3);
    assert.equal(cache.stats().failed, 1);
  } finally {
    cache.dispose();
  }
  const active = [];
  const canceled = createHeightTileCache(
    fixture(),
    "https://example.test/heights/manifest.json",
    1,
    () => {},
    (url, signal) => {
      active.push(signal);
      return new Promise(() => {});
    },
  );
  canceled.update(instances);
  canceled.dispose();
  assert.ok(active.every((s) => s.aborted));
});

test(
  "generated global height manifest validates when available",
  { skip: !fs.existsSync("../tile-service/public/data/moon/elevation-tiles/manifest.json") },
  () => {
    parseHeightTiles(
      JSON.parse(
        fs.readFileSync("../tile-service/public/data/moon/elevation-tiles/manifest.json", "utf8"),
      ),
    );
  },
);

test("height metadata pages load only around the view and expose validated fine tiles", async () => {
  const m = fixture(),
    fine = m.tiles["0/1/1/1"];
  delete m.tiles["0/1/1/1"];
  const pageBytes = new TextEncoder().encode(JSON.stringify({ tiles: { "0/1/1/1": fine } }));
  m.pageLevel = 0;
  m.pages = {
    "0/0/0/0": {
      path: "metadata/0/0/0/0.json",
      lower: 1000,
      upper: 2000,
      sha256: createHash("sha256").update(pageBytes).digest("hex"),
    },
  };
  parseHeightTiles(m);
  let pages = 0;
  const loadPage = async (url) => {
    assert.equal(url, "https://example.test/heights/metadata/0/0/0/0.json");
    pages++;
    return pageBytes;
  };
  const requested = [];
  const cache = createHeightTileCache(
    m,
    "https://example.test/heights/manifest.json",
    1,
    () => {},
    async (url) => {
      requested.push(url);
      return bytes(url.endsWith("/1/1/1.u16") ? 2000 : 1000);
    },
    8,
    { fadeMs: 0, loadPage },
  );
  try {
    for (let i = 0; i < 16; i++) {
      cache.update(terrain(), view(i));
      await tick();
    }
    assert.equal(pages, 1);
    assert.equal(cache.stats().metadataPages, 1);
    assert.ok(requested.some((url) => url.endsWith("/1/1/1.u16")));
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 2000);
  } finally {
    cache.dispose();
  }
});

test("a failed metadata page reaches onError, through the load seam", async () => {
  const m = fixture(),
    fine = m.tiles["0/1/1/1"];
  delete m.tiles["0/1/1/1"];
  const pageBytes = new TextEncoder().encode(JSON.stringify({ tiles: { "0/1/1/1": fine } }));
  m.pageLevel = 0;
  m.pages = {
    "0/0/0/0": {
      path: "metadata/0/0/0/0.json",
      lower: 1000,
      upper: 2000,
      sha256: createHash("sha256").update(pageBytes).digest("hex"),
    },
  };
  parseHeightTiles(m);
  const errors = [];
  const cache = createHeightTileCache(
    m,
    "https://example.test/heights/manifest.json",
    1,
    () => {},
    async () => bytes(1000),
    8,
    {
      fadeMs: 0,
      loadPage: async () => {
        throw new Error("offline");
      },
      onError: (error) => errors.push(error),
    },
  );
  try {
    for (let i = 0; i < 4; i++) {
      cache.update(terrain(), view(i));
      await tick();
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /metadata page/);
    assert.equal(errors[0].cause.message, "offline");
  } finally {
    cache.dispose();
  }
});

test("camera sampling respects the geometry level even when finer heights are prefetched", async () => {
  const cache = createHeightTileCache(
    fixture(),
    "https://example.test/heights/manifest.json",
    1,
    () => {},
    async (url) => bytes(url.endsWith("/1/1/1.u16") ? 2000 : 1000),
    8,
    { fadeMs: 0 },
  );
  const coarse = terrain();
  coarse.faceUVs.set([0, 0, 1, 1]);
  try {
    for (let i = 0; i < 12; i++) {
      cache.update(coarse, view(i));
      await tick();
    }
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 1000);
    assert.ok(cache.stats().resident >= 7);
    cache.update(terrain(), view(20));
    assert.equal(cache.sampleDirection(1, 0.2, -0.2), 2000);
  } finally {
    cache.dispose();
  }
});

test("late root downloads begin their fade on the revealing frame, including the shadow lookup", async () => {
  const cache = createHeightTileCache(
    fixture(),
    "https://height.test/manifest.json",
    1,
    () => {},
    async (url) => bytes(url.includes("/1/1/1.u16") ? 2000 : 1000),
  );
  const instances = terrain();
  cache.update(instances, view(0));
  for (let i = 0; i < 8; i++) await tick();
  cache.update(instances, view(10000));
  assert.equal(cache.bindings.data[10], 0);
  assert.equal(
    cache.shadowIndex.image.data[5],
    0,
    "root fade must not finish while waiting on the network",
  );
  cache.update(instances, view(10150));
  assert.equal(cache.bindings.data[10], 0.5);
  assert.equal(cache.shadowIndex.image.data[5], 0.5);
  cache.dispose();
});
