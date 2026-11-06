import assert from "node:assert/strict";
import test from "node:test";
import { HEIGHT_STRIDE, PAIR, ROW_FLAGS, ROW_STRIDE } from "../src/rendering/binding-row.ts";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import * as THREE from "three/webgpu";
import { createTileInstances, writeTileInstances } from "../src/rendering/tile-instances.ts";
import { createTileBatch } from "../src/tiles/tile.ts";
import { selectTiles } from "../src/tiles/quadtree.ts";
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  ssr: { noExternal: ["pmtiles", "fflate"] },
  build: {
    ssr: fileURLToPath(new URL("../src/rendering/tile-layer.ts", import.meta.url)),
    write: false,
    minify: false,
  },
});
const entry = bundle.output.find((c) => c.type === "chunk" && c.isEntry)!;
const code = entry.code.replace(
  /from (["'])(three(?:\/[^"']*)?)\1/g,
  (_, quote, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`,
);
const { createTileLayer } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

function fixture(
  options = { sunlightSlots: 2, gradientTilesPerFrame: 1, sunlightTilesPerFrame: 1, settleMs: 5 },
) {
  const instances = createTileInstances(64),
    tiles = createTileBatch(64);
  selectTiles(tiles, 0);
  writeTileInstances(tiles, instances, 1737400);
  const width = 20,
    texture = new THREE.DataArrayTexture(new Uint8Array(width * width * 7 * 2), width, width, 7);
  texture.format = THREE.RGFormat;
  texture.type = THREE.UnsignedByteType;
  const bindings = { data: new Float32Array(instances.capacity * HEIGHT_STRIDE) };
  for (let i = 0; i < instances.count; i++)
    bindings.data.set(
      [1, 0, 0.1, 0.9, 0.8, -0.8, 0, 0, 0, 0, 1, instances.faces[i], 0],
      i * HEIGHT_STRIDE,
    );
  let fading = false,
    revision = 1;
  const heights = {
    texture,
    bindings,
    slotVersions: new Uint32Array([0, 1, 0, 0, 0, 0, 0]),
    get revision() {
      return revision;
    },
    shadowIndex: new THREE.DataTexture(
      new Float32Array(8),
      2,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    ),
    manifest: { tileSize: 16, gutter: 2, maxLevel: 4, minMeters: -100, maxMeters: 100 },
    needsFrame: () => fading,
    update() {},
  };
  const jobs: string[] = [],
    errors: unknown[] = [],
    compiled: THREE.ComputeNode[] = [];
  let requests = 0;
  const layer = createTileLayer({
    radiusMeters: 1737400,
    segments: 32,
    instances,
    caches: options,
    requestRender: () => requests++,
    report: (error) => errors.push(error),
  });
  layer.setHeightTiles(heights);
  layer.set({ layer: "terrain", elevation: true });
  const sun = new THREE.Vector3(1, 0, 0);
  const renderer = {
    compileComputeAsync: async (nodes: THREE.ComputeNode[]) => {
      compiled.push(...nodes);
    },
    compute: (node: THREE.ComputeNode) => {
      jobs.push(node.name);
    },
  };
  const view = { clipFromRelative: new THREE.Matrix4().elements, projectionScale: 800, now: 0 };
  const update = (now: number) => {
    layer.update({
      renderer,
      instances,
      view: { ...view, now },
      sun,
      altitude: 1000,
      overlays: [],
      light: null,
    });
  };
  const flags = () => {
    const buffer = layer.group.children[0].geometry.getAttribute("heightBlendFace").data;
    return Array.from(
      { length: instances.count },
      (_, i) => buffer.array[i * ROW_STRIDE + ROW_FLAGS],
    );
  };
  return {
    layer,
    sun,
    heights,
    instances,
    jobs,
    errors,
    compiled,
    renderer,
    update,
    flags,
    get requests() {
      return requests;
    },
    fade(value: boolean) {
      fading = value;
    },
    change() {
      revision++;
    },
    dispose() {
      layer.dispose();
      texture.dispose();
      heights.shadowIndex.dispose();
    },
  };
}

test("GPU caches compile lazily, bake within budgets, reuse camera-only frames, and invalidate safely", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  f.update(0);
  assert.ok(f.flags().every((v) => v === 0));
  assert.equal(f.jobs.length, 0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  f.update(10);
  assert.equal(f.jobs.filter((n) => n.includes("gradient")).length, 1);
  assert.equal(f.jobs.filter((n) => n.includes("sunlight")).length, 1);
  assert.ok(f.flags().every((v) => v >= 256));
  assert.equal(f.flags().filter((v) => v % 256 > 0).length, 1);
  f.update(20);
  assert.equal(f.flags().filter((v) => v % 256 > 0).length, 2);
  const baked = f.jobs.length;
  f.instances.origin[0] += 100;
  f.update(30);
  assert.equal(f.jobs.length, baked, "camera motion must reuse static illumination");
  f.sun.set(0, 1, 0);
  f.update(40);
  assert.ok(f.flags().every((v) => v === 256));
  f.update(50);
  assert.equal(f.flags().filter((v) => v % 256 > 0).length, 1);
  f.change();
  f.update(60);
  assert.ok(
    f.flags().every((v) => v === 256),
    "new distant occluders invalidate all sunlight",
  );
  f.heights.slotVersions[1]++;
  f.update(70);
  assert.equal(
    f.jobs.filter((n) => n.includes("gradient")).length,
    2,
    "reused height slot must rebake gradients",
  );
  f.fade(true);
  for (let i = 0; i < f.instances.count; i++)
    f.heights.bindings.data[i * HEIGHT_STRIDE + PAIR.blend] = 0.5;
  f.update(80);
  assert.ok(
    f.flags().every((v) => v === 0),
    "fading normals and sunlight use original functions",
  );
  assert.deepEqual(f.errors, []);
  assert.ok(f.requests > 0);
  assert.equal(f.layer.group.children[0].geometry.getAttribute("heightBlendFace").itemSize, 4);
});

test("compute submission errors clear all flags and retain the direct shader fallback", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  f.update(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  f.renderer.compute = () => {
    throw new Error("compute unavailable");
  };
  f.update(10);
  assert.ok(f.flags().every((v) => v === 0));
  assert.equal(f.layer.cacheStats().state, "failed");
  assert.equal(f.errors.length, 1);
  f.update(20);
  assert.equal(f.errors.length, 1, "do not retry a failed GPU path every frame");
});

test("disposal during asynchronous compute compilation releases late resources without scheduling frames", async () => {
  const f = fixture();
  let complete!: () => void;
  f.renderer.compileComputeAsync = () =>
    new Promise<void>((resolve) => {
      complete = resolve;
    });
  f.update(0);
  const before = f.requests;
  f.dispose();
  complete();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.requests, before);
  assert.deepEqual(f.errors, []);
});
