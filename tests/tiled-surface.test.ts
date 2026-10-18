import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  Scene,
  PerspectiveCamera,
  Vector3,
  DataTexture,
  WebGPUCoordinateSystem,
} from "three/webgpu";
import type { GlobeContext, GlobeFrame } from "../src/composition.ts";
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  ssr: { noExternal: ["pmtiles", "fflate"] },
  build: {
    ssr: fileURLToPath(new URL("../src/tiled-surface.ts", import.meta.url)),
    write: false,
    minify: false,
  },
});
const entry = bundle.output.find((c) => c.type === "chunk" && c.isEntry)!;
const code = entry.code.replace(
  /from (["'])(three(?:\/[^"']*)?)\1/g,
  (_, quote, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`,
);
const { tiledSurface } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

test("extracted terrain keeps one instanced grid, responds to the camera, and releases owned resources", async () => {
  const radius = 1737400;
  const camera = new PerspectiveCamera(75, 4 / 3, 100, radius * 20);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  (camera as unknown as { _reversedDepth: boolean })._reversedDepth = true;
  camera.position.x = radius * 3;
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const abort = new AbortController();
  const overview = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  let releases = 0;
  overview.addEventListener("dispose", () => releases++);
  const context = {
    body: { name: "Moon", radiusMeters: radius },
    scene: new Scene(),
    camera,
    renderer: {},
    sun: { direction: new Vector3(1, 0, 0), longitudeDeg: 0, latitudeDeg: 0 },
    viewport: { width: 800, height: 600, pixelRatio: 1 },
    signal: abort.signal,
    requestRender() {},
    reportError(error) {
      throw error;
    },
    sampleHeight() {
      return 0;
    },
  } as GlobeContext;
  const surface = tiledSurface({ overview, tileCapacity: 512, maxLevel: 8 });
  await surface.attach(context);
  const frame: GlobeFrame = { context, now: 100, deltaSeconds: 0, elapsedSeconds: 0 };
  surface.update(frame);
  await surface.ready;
  const group = context.scene.children[0],
    mesh = group.children[0];
  assert.ok(surface.stats.tiles > 0);
  const orbitalLevel = surface.stats.deepestLevel;
  camera.position.x = radius + 10000;
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  surface.update({ ...frame, now: 200 });
  assert.ok(surface.stats.deepestLevel > orbitalLevel);
  assert.equal(group.children[0], mesh);
  assert.equal(surface.sampleHeight(1, 0, 0), 0);
  let geometryReleases = 0,
    materialReleases = 0;
  mesh.geometry.addEventListener("dispose", () => geometryReleases++);
  mesh.material.addEventListener("dispose", () => materialReleases++);
  abort.abort();
  surface.dispose();
  surface.dispose();
  assert.equal(context.scene.children.length, 0);
  assert.equal(releases, 1);
  assert.equal(geometryReleases, 1);
  assert.equal(materialReleases, 1);
});
