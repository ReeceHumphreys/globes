import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  DataTexture,
  DirectionalLight,
  Object3D,
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
const {
  TiledGlobe,
  GlobeAnchor,
  Atmosphere,
  Clouds,
  EARTH_AIR,
  Graticule,
  ImageOverlay,
  GeoJsonOverlay,
} = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

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
  near.altitude = 500;
  near.altitudeReference = "ellipsoid";
  globe.update(camera(radius * 3), renderer);
  assert.ok(
    near.position.distanceTo(new Vector3(radius + 500, 0, 0)) < 1e-6,
    "above the ellipsoid",
  );
  near.altitude = 0;
  near.altitudeReference = "terrain";
  const away = camera(radius * 3);
  away.lookAt(radius * 10, 0, 0);
  away.updateMatrixWorld(true);
  globe.update(away, renderer);
  assert.equal(near.visible, false, "behind the camera");
  let groupRemoved = 0;
  const grouped = {
    style: {},
    setAttribute() {},
    remove: () => groupRemoved++,
  } as unknown as HTMLElement;
  const group = new Object3D();
  group.add(new GlobeLabel(grouped, 10, 10));
  globe.add(group);
  globe.remove(group);
  assert.equal(groupRemoved, 1, "removing a parent takes its label off the page");
  globe.dispose();
  assert.equal(removed, 2, "disposing the globe takes its labels off the page");
});

test("an anchor holds its children in east-up-south meters at its point", async () => {
  const globe = new TiledGlobe({ radius, overview: overview() });
  await globe.ready;
  const pad = new GlobeAnchor(0, 0, 500, "ellipsoid"),
    rocket = new Object3D(),
    tilted = new GlobeAnchor(45, 90);
  rocket.position.set(10, 20, 30);
  pad.add(rocket);
  globe.add(pad, tilted);
  globe.update(camera(radius * 3), renderer);
  globe.updateMatrixWorld(true);
  const at = rocket.getWorldPosition(new Vector3());
  // At latitude 0, longitude 0: east is -z, up is +x, south is -y.
  assert.ok(at.distanceTo(new Vector3(radius + 520, -30, -10)) < 1e-6);
  const up = new Vector3(0, 1, 0).applyQuaternion(tilted.quaternion);
  assert.ok(up.distanceTo(globe.normalAt(tilted.position)) < 1e-9);
  assert.throws(() => new GlobeAnchor(91, 0), RangeError);
  globe.dispose();
});

test("the globe says once when the view has fully loaded", async () => {
  const globe = new TiledGlobe({ radius, overview: overview() });
  let loads = 0;
  globe.addEventListener("loaded", () => loads++);
  globe.update(camera(radius * 3), renderer);
  assert.equal(globe.stats.loaded, false, "before its data has loaded");
  await globe.ready;
  globe.update(camera(radius * 3), renderer);
  globe.update(camera(radius * 3), renderer);
  assert.equal(globe.stats.loaded, true);
  assert.equal(loads, 1);
  const sample = globe.sampleHeight(new Vector3(1, 0, 0));
  assert.deepEqual(sample, {
    height: 0,
    verticalDatum: "ellipsoid",
    level: undefined,
    spacing: undefined,
  });
  globe.dispose();
});

test("any HeightSource and ImagerySource plug in, with no dataset behind them", async () => {
  const width = 20;
  const heights = {
    tileSize: 16,
    gutter: 2,
    maxLevel: 0,
    scaleMeters: 1,
    offsetMeters: 0,
    minMeters: 500,
    maxMeters: 500,
    verticalDatum: "sphere",
    bounds: ({ level }: { level: number }) =>
      level === 0 ? { min: 500, max: 500, lower: 500, upper: 500 } : undefined,
    load: async () => new Uint16Array(width * width).fill(500),
  };
  let imageLoads = 0;
  const imagery = {
    tileSize: 16,
    gutter: 2,
    maxLevel: () => 0,
    has: ({ level }: { level: number }) => level === 0,
    load: async () => (imageLoads++, new Uint8Array(width * width * 4).fill(255)),
    describe: () => "Test imagery",
  };
  const globe = new TiledGlobe({ radius, overview: overview(), imagery, elevation: heights });
  await globe.ready;
  // Elevation adds GPU caches, so this renderer compiles compute jobs too.
  const computing = { ...renderer, compileComputeAsync: async () => {} };
  const started = Date.now();
  while (!globe.stats.loaded && Date.now() - started < 3000) {
    globe.update(camera(radius * 3), computing);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(globe.stats.loaded, true);
  assert.ok(imageLoads >= 4, "every root's imagery");
  assert.deepEqual(globe.sampleHeight(new Vector3(1, 0, 0)), {
    height: 500,
    verticalDatum: "sphere",
    level: 0,
    spacing: (Math.PI * radius) / 16,
  });
  globe.dispose();
});

test("disposing before the surface loads releases its textures", async () => {
  const texture = overview();
  let disposed = 0;
  texture.addEventListener("dispose", () => disposed++);
  const globe = new TiledGlobe({ radius, overview: texture });
  globe.dispose();
  await globe.ready;
  assert.equal(disposed, 1);
});

test("an Atmosphere child is found by the globe and sized from its radius", async () => {
  const globe = new TiledGlobe({ radius: 6_378_137, overview: overview() });
  const air = new Atmosphere(EARTH_AIR);
  globe.add(air);
  await globe.ready;
  globe.update(camera(6_378_137 * 3), renderer);
  // The globe asked for its ground light, which builds the tables for this radius.
  assert.ok(Math.abs(air.scale.x - (6_378_137 + EARTH_AIR.height) * 1.01) < 1e-3);
  const view = { reversedDepth: true, bufferHeight: 600 };
  const light = air.update(renderer, camera(6_378_137 * 3), view);
  assert.equal(light.transmittance.image.width, 256);
  assert.equal(air.update(renderer, camera(6_378_137 * 3), view), light, "built once per radius");
  air.dispose();
  assert.equal(air.parent, null);
  globe.update(camera(6_378_137 * 3), renderer); // and the globe copes with its removal
  const earth = new TiledGlobe({ radius: 6_378_137, overview: overview() });
  const sky = new Atmosphere(EARTH_AIR);
  earth.add(sky);
  // With no sun light the sun is over longitude 90° east, -z.
  const noon = sky.sunlightAt(new Vector3(0, 0, -6_378_237)),
    dusk = sky.sunlightAt(new Vector3(6_379_137, 0, 0)),
    night = sky.sunlightAt(new Vector3(0, 0, 6_378_237));
  assert.ok(noon.r > 0.8 && noon.b > 0.6, "little loss straight down");
  assert.ok(dusk.r > dusk.b && dusk.r < noon.r, "red and dim at the terminator");
  assert.equal(night.r + night.g + night.b, 0, "the planet's shadow");
  earth.dispose();
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

test("disposing a GeoJSON overlay removes its point markers", async () => {
  let removed = 0;
  const element = {
    style: {},
    setAttribute() {},
    remove: () => removed++,
  } as unknown as HTMLElement;
  const overlay = new GeoJsonOverlay({
    data: { type: "Point", coordinates: [10, 20] },
    marker: () => element,
  });
  await Promise.resolve();
  assert.ok(overlay.children.length > 0);
  overlay.dispose();
  assert.equal(removed, 1);
});

test("clouds reach sky and terrain through one light, which the terrain does not own", async () => {
  const globe = new TiledGlobe({ radius: 6_378_137, overview: overview() });
  const air = new Atmosphere(EARTH_AIR);
  const clouds = new Clouds({ map: "clouds.jpg" });
  globe.add(air, clouds);
  await globe.ready;
  const view = { reversedDepth: true, bufferHeight: 600 };
  const high = camera(6_378_137 * 3);
  assert.equal(air.update(renderer, high, view).cloudStrength, 0, "no image yet, so no clouds");

  clouds.map = Object.assign(new DataTexture(new Uint8Array(4), 1, 1), { image: { width: 1 } });
  const light = air.update(renderer, high, view);
  assert.equal(light.cloudMap, clouds.map);
  assert.equal(light.cloudAltitude, clouds.altitude);
  assert.equal(light.cloudStrength, 1);
  assert.equal(air.update(renderer, camera(6_378_137 + 50_000), view).cloudStrength, 0, "faded");

  globe.update(high, renderer);
  let freed = 0;
  light.transmittance.addEventListener("dispose", () => freed++);
  light.skyLight.addEventListener("dispose", () => freed++);
  clouds.map.addEventListener("dispose", () => freed++);
  globe.dispose();
  assert.equal(freed, 0, "they stay with the Atmosphere and Clouds");
  air.dispose();
  assert.equal(freed, 2);
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
