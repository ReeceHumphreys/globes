import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  DataTexture,
  DirectionalLight,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGPUCoordinateSystem,
} from "three/webgpu";
import { GlobeLabel } from "../src/globe-label.ts";

// WGSL is imported with Vite's ?raw, so bundle the module before importing it in Node.
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  ssr: { noExternal: ["pmtiles", "fflate"] },
  build: {
    ssr: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    write: false,
    minify: false,
  },
});
const entry = bundle.output.find((c) => c.type === "chunk" && c.isEntry)!;
const code = entry.code.replace(
  /from (["'])(three(?:\/[^"']*)?)\1/g,
  (_, quote, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`,
);
const { TiledGlobe, Atmosphere, EARTH_AIR, Graticule, ImageOverlay, GeoJsonOverlay } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

const radius = 1737400;
const renderer = {
  compute() {},
  reversedDepthBuffer: true,
  getDrawingBufferSize: (out: Vector2) => out.set(800, 600),
  getPixelRatio: () => 1,
};
function camera(distance: number) {
  const c = new PerspectiveCamera(75, 4 / 3, 100, radius * 20);
  c.coordinateSystem = WebGPUCoordinateSystem;
  c.position.x = distance;
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld(true);
  c.updateProjectionMatrix();
  return c;
}
const overview = () => new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);

test("a TiledGlobe is a scene object: one instanced grid that refines toward the camera", async () => {
  const texture = overview();
  let textureReleases = 0;
  texture.addEventListener("dispose", () => textureReleases++);
  const globe = new TiledGlobe({ radius, overview: texture, tileCapacity: 512, maxLevel: 8 });
  const scene = new Scene().add(globe);
  await globe.ready;
  assert.equal(globe.display, "overview");
  const view = camera(radius * 3);
  globe.update(view, renderer);
  const grid = globe.children[0],
    mesh = grid.children[0];
  assert.ok(globe.stats.tiles > 0);
  const orbitalLevel = globe.stats.deepestLevel;
  view.position.x = radius + 10000;
  view.updateMatrixWorld(true);
  globe.update(view, renderer);
  assert.ok(globe.stats.deepestLevel > orbitalLevel);
  assert.equal(grid.children[0], mesh, "the grid is reused, not rebuilt");
  assert.equal(globe.heightAt(new Vector3(1, 0, 0)), 0);
  let releases = 0;
  mesh.geometry.addEventListener("dispose", () => releases++);
  mesh.material.addEventListener("dispose", () => releases++);
  globe.dispose();
  globe.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(textureReleases, 1);
  assert.equal(releases, 2);
});

test("selection follows the globe's own transform", async () => {
  const globe = new TiledGlobe({ radius, overview: overview(), tileCapacity: 512, maxLevel: 8 });
  await globe.ready;
  globe.update(camera(radius + 10000), renderer);
  const near = globe.stats.deepestLevel;
  // Same camera, globe moved far away: the view is now coarse.
  globe.position.set(radius * 50, 0, 0);
  globe.updateMatrixWorld(true);
  globe.update(camera(radius + 10000), renderer);
  assert.ok(globe.stats.deepestLevel < near);
  globe.dispose();
});

test("settings are plain properties and apply before and after loading", async () => {
  const globe = new TiledGlobe({ radius, overview: overview() });
  globe.wireframe = true;
  globe.shadowSteps = 12;
  await globe.ready;
  const material = globe.children[0].children[0].material;
  assert.equal(material.wireframe, true);
  assert.equal(globe.shadowSteps, 12);
  let changes = 0;
  globe.addEventListener("change", () => changes++);
  globe.display = "checker";
  assert.equal(globe.display, "checker");
  assert.ok(changes > 0, "setting a property asks for a render");
  assert.throws(() => (globe.shadowSteps = NaN), RangeError);
  globe.dispose();
});

test("raycasting hits the sphere in world space, and the sun comes from a DirectionalLight", async () => {
  const sun = new DirectionalLight();
  const globe = new TiledGlobe({ radius, overview: overview(), sun });
  await globe.ready;
  globe.position.set(0, 0, -radius * 4);
  globe.rotation.y = Math.PI / 2;
  new Scene().add(globe, sun);
  globe.updateMatrixWorld(true);
  const raycaster = new Raycaster(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  const [hit] = raycaster.intersectObject(globe);
  assert.ok(Math.abs(hit.distance - radius * 3) < 1e-3);
  assert.equal(hit.object, globe);
  // Light from world +Z. The globe is turned 90° about Y, so that is local -X.
  sun.position.set(0, 0, 1);
  const local = globe.sunDirection(new Vector3());
  assert.ok(local.distanceTo(new Vector3(-1, 0, 0)) < 1e-9);
  const point = globe.positionAt(0, 0);
  assert.ok(point.distanceTo(new Vector3(radius, 0, 0)) < 1e-6);
  globe.dispose();
});

test("labels sit on the surface and hide behind the horizon or behind the camera", async () => {
  let removed = 0;
  const element = {
    style: {},
    setAttribute() {},
    remove: () => removed++,
  } as unknown as HTMLElement;
  const globe = new TiledGlobe({ radius, overview: overview() });
  await globe.ready;
  const near = new GlobeLabel(element, 0, 0),
    far = new GlobeLabel(element, 0, 180);
  globe.add(near, far);
  globe.update(camera(radius * 3), renderer);
  assert.ok(near.position.distanceTo(new Vector3(radius, 0, 0)) < 1e-6);
  assert.equal(near.visible, true);
  assert.equal(far.visible, false, "far side is behind the horizon");
  const away = camera(radius * 3);
  away.lookAt(radius * 10, 0, 0);
  away.updateMatrixWorld(true);
  globe.update(away, renderer);
  assert.equal(near.visible, false, "behind the camera");
  globe.dispose();
  assert.equal(removed, 2, "disposing the globe takes its labels off the page");
});

test("an Atmosphere child is found by the globe and sized from its radius", async () => {
  const globe = new TiledGlobe({ radius: 6_378_137, overview: overview() });
  const air = new Atmosphere(EARTH_AIR);
  globe.add(air);
  await globe.ready;
  globe.update(camera(6_378_137 * 3), renderer);
  // The globe asked for its ground light, which builds the tables for this radius.
  assert.ok(Math.abs(air.scale.x - (6_378_137 + EARTH_AIR.height) * 1.01) < 1e-3);
  const light = air.lightFor(6_378_137);
  assert.equal(light.transmittance.image.width, 256);
  assert.equal(air.lightFor(6_378_137), light, "tables are built once per radius");
  air.dispose();
  assert.equal(air.parent, null);
  globe.update(camera(6_378_137 * 3), renderer); // and the globe copes with its removal
  globe.dispose();
});

test("overlays recompile the terrain only when the list changes, and toggling is free", async () => {
  const globe = new TiledGlobe({ radius, overview: overview() });
  const grid = new Graticule({ opacity: 0.4 });
  globe.add(grid);
  await globe.ready;
  const view = camera(radius * 3);
  globe.update(view, renderer);
  const material = globe.children.find((c) => c.name === "Globe terrain")!.children[0].material;
  assert.equal(grid.strength.value, 0.4);
  const painted = material.colorNode;
  const version = material.version;

  grid.visible = false;
  globe.update(view, renderer);
  assert.equal(grid.strength.value, 0);
  assert.equal(material.colorNode, painted);
  assert.equal(material.version, version);

  const bare = new Graticule();
  globe.add(bare);
  globe.update(view, renderer);
  assert.notEqual(material.colorNode, painted);
  grid.dispose();
  bare.dispose();
  globe.update(view, renderer);
  assert.notEqual(material.colorNode, painted, "back to the plain surface");
  globe.dispose();
});

test("GeoJSON lines are built on the globe's surface and cleaned up with the overlay", async () => {
  const globe = new TiledGlobe({ radius, overview: overview() });
  const overlay = new GeoJsonOverlay({
    data: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [5, 0],
      ],
    },
  });
  globe.add(overlay);
  await globe.ready;
  globe.update(camera(radius * 3), renderer);
  const lines = overlay.children.find((c: { name: string }) => c.name === "GeoJSON lines");
  assert.equal(lines.geometry.instanceCount, 5);
  overlay.dispose();
  assert.equal(overlay.parent, null);
  globe.update(camera(radius * 3), renderer);
  globe.dispose();
});

test("graticule options are checked and an image overlay frees its texture", () => {
  assert.throws(() => new Graticule({ spacing: 7 }), RangeError);
  assert.throws(() => new Graticule({ spacing: 0 }), RangeError);
  assert.doesNotThrow(() => new Graticule({ spacing: 15 }));
  assert.throws(() => new Graticule({ parallels: [91] }), RangeError);
  assert.throws(() => new Graticule({ parallels: [1, 2, 3, 4, 5] }), RangeError);
  let disposed = 0;
  const map = new DataTexture(new Uint8Array(4), 1, 1);
  map.addEventListener("dispose", () => disposed++);
  const overlay = new ImageOverlay({ map });
  assert.equal(overlay.map, map);
  assert.equal(map.flipY, false, "north is the top row");
  overlay.dispose();
  assert.equal(disposed, 1);
});

test("a failed overview still builds the surface and reports the error", async () => {
  const errors: unknown[] = [];
  const globe = new TiledGlobe({ radius, overview: "missing.jpg" });
  globe.addEventListener("error", ({ error }: { error: unknown }) => errors.push(error));
  await globe.ready;
  assert.equal(globe.display, "terrain");
  assert.equal(errors.length, 1);
  globe.dispose();
});
