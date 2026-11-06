import assert from "node:assert/strict";
import test from "node:test";
import { createImageryCache } from "../src/imagery/tile-cache.ts";
import { parseImageryManifest } from "../src/imagery/manifest.ts";
import { createTileBatch } from "../src/tiles/tile.ts";
import { createTileInstances, writeTileInstances } from "../src/rendering/tile-instances.ts";

const manifest = {
  version: 1,
  body: "Moon",
  projection: "normalized-cube",
  radiusMeters: 1737400,
  axes: { north: "+Y", longitude0: "+X", longitude90East: "-Z" },
  addressing: { template: "{face}/{level}/{x}/{y}.png", yDirection: "up" },
  textureFlipY: true,
  format: "png",
  colorSpace: "srgb",
  minLevel: 0,
  maxLevel: 2,
  tileSize: 16,
  gutter: 2,
  imageSize: 20,
  textureUV: { offset: 0.1, scale: 0.8 },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function terrain(face, level, x, y) {
  const batch = createTileBatch(1);
  batch.count = 1;
  batch.face[0] = face;
  batch.level[0] = level;
  batch.x[0] = x;
  batch.y[0] = y;
  const instances = createTileInstances(1);
  writeTileInstances(batch, instances, 1737400);
  return instances;
}

test("ready ancestors map deep terrain into padded images while requests stay capped", async () => {
  const requests = [];
  const load = (url, signal) =>
    new Promise((resolve, reject) => requests.push({ url, signal, resolve, reject, done: false }));
  const cache = createImageryCache(
    parseImageryManifest(manifest),
    "http://localhost/data/manifest.json",
    1,
    () => {},
    load,
  );
  const instances = terrain(0, 7, 81, 33);
  cache.update(instances);
  assert.equal(requests.length, 4);
  assert.equal(cache.bindings.data[0], 0); // Global overview until a tile arrives.
  const root = requests.find((r) => r.url.endsWith("/0/0/0/0.png"));
  root.done = true;
  root.resolve(new Uint8Array(20 * 20 * 4).fill(255));
  await tick();
  cache.update(instances);
  const rootSlot = cache.bindings.data[0];
  assert.ok(rootSlot > 0);
  assert.ok(Math.abs(cache.bindings.data[2] - (0.1 + (81 / 128) * 0.8)) < 1e-6);
  assert.ok(Math.abs(cache.bindings.data[4] - (1 / 128) * 0.8) < 1e-6);
  for (let pass = 0; pass < 8; pass++) {
    for (const r of requests.filter((r) => !r.done)) {
      r.done = true;
      r.resolve(new Uint8Array(20 * 20 * 4).fill(255));
    }
    await tick();
  }
  cache.update(instances);
  assert.notEqual(cache.bindings.data[0], rootSlot);
  assert.ok(cache.bindings.data[1] > 0); // Ready parent is retained for no-data.
  assert.ok(Math.abs(cache.bindings.data[2] - (0.1 + ((81 / 128) * 4 - 2) * 0.8)) < 1e-6);
  assert.ok(Math.abs(cache.bindings.data[3] - (0.1 + ((33 / 128) * 4 - 1) * 0.8)) < 1e-6);
  assert.ok(Math.abs(cache.bindings.data[4] - (4 / 128) * 0.8) < 1e-6);
  assert.ok(requests.every((r) => Number(new URL(r.url).pathname.split("/").at(-3)) <= 2));
  assert.equal(cache.texture.image.depth, 129);
  cache.dispose();
});

test("disposal aborts outstanding work and suppresses late callbacks", async () => {
  const requests = [];
  let notifications = 0;
  const cache = createImageryCache(
    manifest,
    "http://localhost/manifest.json",
    1,
    () => notifications++,
    (url, signal) => new Promise((resolve) => requests.push({ signal, resolve })),
  );
  cache.update(terrain(0, 0, 0, 0));
  cache.dispose();
  assert.ok(requests.every((r) => r.signal.aborted));
  requests.forEach((r) => r.resolve(new Uint8Array(1600)));
  await tick();
  assert.equal(notifications, 0);
});

test("manifest validation rejects incompatible frame and texture conventions", () => {
  assert.equal(parseImageryManifest(manifest), manifest);
  for (const changed of [
    { body: "Earth" },
    { radiusMeters: 6371000 },
    { maxLevel: Infinity },
    { textureFlipY: false },
    { imageSize: 16 },
    { axes: { ...manifest.axes, longitude90East: "+Z" } },
  ]) {
    assert.throws(() =>
      parseImageryManifest({ ...manifest, ...changed }, { name: "Moon", radiusMeters: 1737400 }),
    );
  }
});

test("cache pressure admits a complete working set instead of permanently losing leaves", async () => {
  const batch = createTileBatch(16);
  batch.count = 16;
  for (let i = 0; i < 16; i++) {
    batch.face[i] = 0;
    batch.level[i] = 2;
    batch.x[i] = i % 4;
    batch.y[i] = Math.floor(i / 4);
  }
  const instances = createTileInstances(16);
  writeTileInstances(batch, instances, 1737400);
  const requests = [];
  const cache = createImageryCache(
    manifest,
    "http://localhost/manifest.json",
    16,
    () => cache.update(instances),
    async (url) => {
      requests.push(url);
      return new Uint8Array(1600).fill(255);
    },
    14,
  );
  cache.update(instances);
  for (let i = 0; i < 20; i++) await tick();
  assert.match(cache.status(), /cache cap 1/);
  assert.doesNotMatch(cache.status(), /unavailable/);
  assert.match(cache.status(), /0 loading/);
  const levels = requests.map((url) => Number(new URL(url).pathname.split("/").at(-3)));
  assert.ok(levels.every((level) => level <= 2));
  assert.ok(levels.includes(2), "spare slots still request the finest tiles");
  for (let i = 0; i < 16; i++) {
    assert.ok(cache.bindings.data[i * 11] > 0, "every leaf keeps a resident image");
    const scale = cache.bindings.data[i * 11 + 4];
    assert.ok(Math.abs(scale - 0.4) < 1e-6 || Math.abs(scale - 0.8) < 1e-6);
  }
  cache.dispose();
});

test("moving across a full cache evicts obsolete records and can revisit them", async () => {
  let instances = terrain(0, 2, 0, 0);
  const requests = [];
  const cache = createImageryCache(
    manifest,
    "http://localhost/manifest.json",
    1,
    () => cache.update(instances),
    async (url) => {
      requests.push(url);
      return new Uint8Array(1600).fill(255);
    },
    8,
  );
  for (const [face, x, y] of [
    [0, 0, 0],
    [1, 3, 3],
    [2, 1, 2],
    [3, 2, 1],
    [0, 0, 0],
  ]) {
    instances = terrain(face, 2, x, y);
    cache.update(instances);
    for (let i = 0; i < 12; i++) await tick();
    assert.match(cache.status(), /0 loading/);
    assert.doesNotMatch(cache.status(), /unavailable/);
    assert.ok(
      Math.abs(cache.bindings.data[4] - 0.8) < 1e-6,
      "finest requested tile eventually becomes resident",
    );
    assert.ok(cache.bindings.data[0] > 0 && cache.bindings.data[1] > 0);
  }
  const count = requests.length;
  for (let i = 0; i < 12; i++) await tick();
  assert.equal(requests.length, count, "settled camera must not trigger eviction/reload loops");
  assert.ok(requests.filter((url) => url.endsWith("/0/2/0/0.png")).length >= 2);
  cache.dispose();
});

const streamingView = (now) => ({
  now,
  projectionScale: 800,
  clipFromRelative: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0]),
});
test("visible imagery requests favor projected area and screen center over tile order", async () => {
  const batch = createTileBatch(2);
  batch.count = 2;
  batch.face.fill(0);
  batch.level.fill(1);
  batch.x.set([0, 1]);
  batch.y.fill(0);
  const instances = createTileInstances(2);
  writeTileInstances(batch, instances, 1737400);
  instances.anchors.set([400, 0, -100, 0, 0, -100]);
  const requests = [];
  const cache = createImageryCache(
    manifest,
    "http://localhost/manifest.json",
    2,
    () => cache.update(instances, streamingView(0)),
    async (url) => {
      requests.push(url);
      return new Uint8Array(1600).fill(255);
    },
    128,
    { fadeMs: 0, prefetchLimit: 0 },
  );
  cache.update(instances, streamingView(0));
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(
    requests.findIndex((url) => url.endsWith("/0/1/1/0.png")) <
      requests.findIndex((url) => url.endsWith("/0/1/0/0.png")),
  );
  cache.dispose();
});

test("parent-to-child fades advance smoothly and stop requesting animation frames", async () => {
  const instances = terrain(0, 1, 0, 0);
  const cache = createImageryCache(
    manifest,
    "http://localhost/manifest.json",
    1,
    () => {},
    async () => new Uint8Array(1600).fill(255),
    128,
    { prefetchLimit: 0, fadeMs: 250 },
  );
  cache.update(instances, streamingView(0));
  for (let i = 0; i < 12; i++) await tick();
  cache.update(instances, streamingView(0));
  const root = cache.bindings.data[0];
  assert.equal(cache.bindings.data[10], 0);
  assert.equal(cache.needsFrame(), true);
  cache.update(instances, streamingView(125));
  assert.equal(cache.bindings.data[10], 0.5);
  cache.update(instances, streamingView(250));
  assert.notEqual(cache.bindings.data[0], root);
  assert.equal(cache.bindings.data[1], root);
  assert.equal(cache.bindings.data[10], 0);
  cache.update(instances, streamingView(375));
  assert.equal(cache.bindings.data[10], 0.5);
  cache.update(instances, streamingView(500));
  assert.equal(cache.bindings.data[10], 1);
  assert.equal(cache.needsFrame(), false);
  cache.dispose();
});

test("regional NAC tiles extend only published addresses, sharing global fallback and residency", async () => {
  const base = parseImageryManifest({ ...manifest, id: "test-global" }),
    urls = [];
  const cache = createImageryCache(
    base,
    "https://example.test/wac/manifest.json",
    1,
    () => {},
    async (url) => {
      urls.push(url);
      return new Uint8Array(20 * 20 * 4).fill(255);
    },
    16,
  );
  const catalog = {
    version: 1,
    body: "Moon",
    radiusMeters: 1737400,
    baseId: base.id,
    baseMaxLevel: 2,
    tileSize: 16,
    gutter: 2,
    sites: [
      {
        id: "apollo12",
        name: "Apollo 12",
        latitudeDeg: -3,
        longitudeDeg: -23,
        radiusMeters: 2000,
        maxLevel: 5,
        source: {
          sourcePage: "https://example.test/source",
          credit: "LROC",
          nativeResolutionMeters: 0.5,
        },
        tiles: ["0/3/1/1", "0/4/2/2", "0/5/5/5"],
      },
    ],
  };
  try {
    cache.setRegions(catalog, "https://example.test/apollo/catalog.json");
    const local = terrain(0, 5, 5, 5);
    cache.update(local);
    for (let i = 0; i < 10; i++) {
      await tick();
      cache.update(local);
    }
    assert.ok(urls.includes("https://example.test/apollo/apollo12/0/5/5/5.png"));
    assert.ok(urls.includes("https://example.test/wac/0/2/0/0.png"));
    assert.ok(cache.bindings.data[0] > 0);
    assert.ok(cache.bindings.data[1] > 0);
    assert.ok(cache.stats().resident <= 16);
    const before = urls.length,
      outside = terrain(1, 5, 20, 20);
    cache.update(outside);
    for (let i = 0; i < 5; i++) {
      await tick();
      cache.update(outside);
    }
    assert.ok(
      urls
        .slice(before)
        .every((url) => !url.includes("/apollo/") && Number(url.split("/").at(-3)) <= 2),
    );
  } finally {
    cache.dispose();
  }
});

test("a wanted imagery tile is retried three times and then stays unavailable", async () => {
  let tries = 0;
  const cache = createImageryCache(
    manifest,
    "http://localhost/manifest.json",
    1,
    () => {},
    async () => {
      tries++;
      throw new Error("503");
    },
  );
  const instances = terrain(0, 0, 0, 0);
  try {
    cache.update(instances);
    for (let i = 0; i < 8; i++) {
      await tick();
      cache.update(instances);
    }
    assert.equal(tries, 18);
    assert.match(cache.status(), /6 unavailable/);
    cache.update(instances);
    await tick();
    assert.equal(tries, 18);
  } finally {
    cache.dispose();
  }
});
