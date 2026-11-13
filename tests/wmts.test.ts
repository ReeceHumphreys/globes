import assert from "node:assert/strict";
import test from "node:test";
import { createWmtsImagery, gridPosition, wmtsRootMaxLevel } from "../src/imagery/wmts.ts";

test("positions land on each kind of grid", () => {
  assert.deepEqual(gridPosition({ type: "geographic", tileDegrees: 180 }, 90, -180), [0, 0]);
  assert.deepEqual(gridPosition({ type: "geographic", tileDegrees: 180 }, 0, 0), [1, 0.5]);
  const [x, y] = gridPosition({ type: "mercator" }, 0, 90);
  assert.ok(Math.abs(x - 0.75) < 1e-12 && Math.abs(y - 0.5) < 1e-12);
});

test("polar grids match EPSG:3031", () => {
  const grid = {
    type: "polar",
    pole: -1,
    halfWidth: 4194304,
    rootTiles: 2,
    semiMajorAxis: 6378137,
    eccentricity: 0.0818191908426,
    trueScaleDegrees: 71,
    centralMeridianDegrees: 0,
  } as const;
  // The pole is the middle of a 2x2 root, and 75°S on the prime meridian is 1638783 m north.
  assert.deepEqual(
    gridPosition(grid, -90, 0).map((value) => Math.round(value * 1e6) / 1e6),
    [1, 1],
  );
  const [x, y] = gridPosition(grid, -75, 0);
  assert.ok(Math.abs(x - 1) < 1e-9);
  assert.ok(Math.abs((1 - y) * 4194304 - 1638783) < 2);
});

test("a tile is built from whichever source tiles it overlaps", async () => {
  const urls: string[] = [];
  const { load } = createWmtsImagery(
    { globe: { url: "https://x.test/{z}/{row}/{col}.jpg", maxLevel: 3 } },
    async (url) => {
      urls.push(url);
      return { data: new Uint8ClampedArray(256 * 256 * 4).fill(200), width: 256, height: 256 };
    },
  );
  const pixels = await load({ root: 1, level: 0, x: 0, y: 0 }, new AbortController().signal);
  assert.equal(pixels.length, 260 * 260 * 4);
  assert.equal(pixels[(130 * 260 + 130) * 4], 200);
  // The eastern hemisphere's tile, and its neighbors for the gutter.
  assert.ok(urls.includes("https://x.test/0/0/1.jpg"), urls.join(" "));
  assert.equal(new Set(urls).size, 2);
});

test("a service with no tile leaves the pixels empty, for what lies under them", async () => {
  const { load } = createWmtsImagery(
    { globe: { url: "https://x.test/{z}/{row}/{col}.jpg", maxLevel: 0 } },
    async () => undefined,
  );
  const pixels = await load({ root: 0, level: 0, x: 0, y: 0 }, new AbortController().signal);
  assert.ok(pixels.every((value) => value === 0));
});

test("aborting one tile leaves a neighbor sharing its source download", async () => {
  const fetches = new Map<string, number>();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { load } = createWmtsImagery(
    { globe: { url: "https://x.test/{z}/{row}/{col}.jpg", maxLevel: 0 } },
    async (url, signal) => {
      fetches.set(url, (fetches.get(url) ?? 0) + 1);
      await gate;
      signal.throwIfAborted();
      return { data: new Uint8ClampedArray(256 * 256 * 4).fill(200), width: 256, height: 256 };
    },
  );
  const west = new AbortController();
  const east = new AbortController();
  const a = load({ root: 0, level: 0, x: 0, y: 0 }, west.signal);
  const b = load({ root: 1, level: 0, x: 0, y: 0 }, east.signal);
  west.abort();
  release();
  await assert.rejects(a, { name: "AbortError" });
  const pixels = await b;
  assert.equal(east.signal.aborted, false);
  assert.equal(pixels[(130 * 260 + 130) * 4], 200);
  // West and east level-0 tiles sample the same two source tiles.
  assert.deepEqual([...fetches.keys()].sort(), [
    "https://x.test/0/0/0.jpg",
    "https://x.test/0/0/1.jpg",
  ]);
  for (const count of fetches.values()) assert.equal(count, 1);
});

test("a failed source tile is fetched again", async () => {
  const reads = new Map<string, number>();
  const { load } = createWmtsImagery(
    { globe: { url: "https://x.test/{z}/{row}/{col}.jpg", maxLevel: 0 } },
    async (url) => {
      const n = (reads.get(url) ?? 0) + 1;
      reads.set(url, n);
      if (n === 1) throw new Error("offline");
      return { data: new Uint8ClampedArray(256 * 256 * 4).fill(9), width: 256, height: 256 };
    },
  );
  const signal = new AbortController().signal;
  await assert.rejects(load({ root: 0, level: 0, x: 0, y: 0 }, signal), /offline/);
  const pixels = await load({ root: 0, level: 0, x: 0, y: 0 }, signal);
  assert.equal(pixels[0], 9);
  for (const n of reads.values()) assert.equal(n, 2);
});

test("depth follows how fine the service is, root by root", () => {
  const coarse = { url: "", maxLevel: 3 };
  assert.equal(wmtsRootMaxLevel({ globe: coarse }, 0), 3);
  assert.equal(wmtsRootMaxLevel({ globe: coarse }, 2), 0);
  const gibs = { type: "geographic", tileDegrees: 288 } as const;
  const globe = { url: "", maxLevel: 7, tileSize: 512, grid: gibs };
  assert.equal(wmtsRootMaxLevel({ globe }, 1), 8);
  assert.equal(wmtsRootMaxLevel({ globe }, 3), 5);
  // A cap's own layer sets its depth, and lifts the deepest level of the whole source.
  const north = { url: "", maxLevel: 9, grid: { type: "geographic", tileDegrees: 180 } } as const;
  const imagery = createWmtsImagery({ globe: coarse, north });
  assert.equal(wmtsRootMaxLevel({ globe: coarse, north }, 2), 6);
  assert.equal(imagery.maxLevel(), 9);
  assert.ok(imagery.has({ root: 2, level: 6, x: 0, y: 0 }));
  assert.ok(!imagery.has({ root: 2, level: 7, x: 0, y: 0 }));
  assert.ok(imagery.has({ root: 0, level: 3, x: 0, y: 0 }));
  assert.ok(!imagery.has({ root: 0, level: 4, x: 0, y: 0 }));
});
