// 3D Tiles standing on the globe. The tileset is streamed by 3DTilesRendererJS; the
// globe only places it and, for solid models, hides the terrain under it.
//   ?site=pad       a generated box at LC-39A, over a terrain mask (default)
//   ?site=starbase  USGS 2023 lidar of the Starbase launch site, as a point cloud
import * as THREE from "three/webgpu";
import { TilesRenderer } from "3d-tiles-renderer";
import { GlobeControls, TerrainMask, TiledGlobe, geographicToDirection } from "tiled-globe";

const SITES = {
  pad: { tileset: "pad/tileset.json", latitude: 28.6083, longitude: -80.6041, mask: true },
  starbase: { tileset: "starbase/tileset.json", latitude: 25.997, longitude: -97.157, mask: false },
};
const params = new URLSearchParams(location.search);
const site = SITES[(params.get("site") ?? "pad") as keyof typeof SITES] ?? SITES.pad;

const renderer = new THREE.WebGPURenderer({ antialias: true, reversedDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
await renderer.init();
// Tilesets sit at Earth-centered positions; this keeps them steady up close.
renderer.highPrecision = true;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 1e8);
const sun = new THREE.DirectionalLight(0xffffff, 3);
geographicToDirection(40, -60, sun.position);
scene.add(sun, sun.target, new THREE.AmbientLight(0xffffff, 0.3));

const globe = new TiledGlobe({
  radius: 6378137,
  flattening: 1 / 298.257223563,
  sun,
  imagery: "data/earth/s2cloudless-2020-z7/manifest.json",
  regions: "data/earth/sites/catalog.json",
  elevation: "data/earth/elevation-tiles/manifest.json",
});
globe.addEventListener("error", ({ error }) => console.warn("[globe]", error));
scene.add(globe);

// 3D Tiles are Earth-centered with z north; the globe's frame has y north.
const tiles = new TilesRenderer(site.tileset);
// WebGPU draws points one pixel wide, so a point cloud refines further to fill in.
if (!site.mask) tiles.errorTarget = 1;
tiles.group.rotation.x = -Math.PI / 2;
globe.add(tiles.group);
tiles.setCamera(camera);
tiles.addEventListener("load-error", (event) => console.warn("[tiles]", event));

// A solid model hides the coarser ground under it. A point cloud has gaps, so it doesn't.
if (site.mask && params.get("mask") !== "0")
  globe.add(new TerrainMask(site.latitude, site.longitude, { width: 120, length: 90 }));

const controls = new GlobeControls(camera, renderer.domElement, globe);
controls.goTo(
  Number(params.get("lat") ?? site.latitude),
  Number(params.get("lon") ?? site.longitude),
  Number(params.get("altitude") ?? 600),
);

// ?look=<heading>,<distance m>,<elevation°> replaces the controls with a fixed oblique view.
const look = params.get("look")?.split(",").map(Number);
if (look) {
  controls.dispose();
  const [heading, distance, elevation] = look;
  const target = globe.positionAt(site.latitude, site.longitude, 0);
  const up = globe.normalAt(target);
  const north = new THREE.Vector3(0, 1, 0).projectOnPlane(up).normalize();
  const east = new THREE.Vector3().crossVectors(north, up);
  const h = THREE.MathUtils.degToRad(heading + 180),
    e = THREE.MathUtils.degToRad(elevation);
  camera.position
    .copy(target)
    .addScaledVector(north, Math.cos(h) * Math.cos(e) * distance)
    .addScaledVector(east, Math.sin(h) * Math.cos(e) * distance)
    .addScaledVector(up, Math.sin(e) * distance);
  camera.up.copy(up);
  camera.near = 1;
  camera.lookAt(target.addScaledVector(up, 40));
  camera.updateProjectionMatrix();
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const buffer = new THREE.Vector2();
renderer.setAnimationLoop(() => {
  if (!look) controls.update();
  globe.update(camera, renderer);
  // setResolutionFromRenderer is typed for WebGLRenderer; the buffer size is all it reads.
  tiles.setResolution(camera, renderer.getDrawingBufferSize(buffer));
  tiles.update();
  renderer.render(scene, camera);
});
Object.assign(globalThis, { globe, tiles });
