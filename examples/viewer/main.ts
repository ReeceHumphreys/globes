import * as THREE from "three/webgpu";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import {
  Atmosphere,
  Clouds,
  GeoJsonOverlay,
  Graticule,
  createBloom,
  EARTH_AIR,
  MARS_AIR,
  GlobeControls,
  GlobeLabel,
  TiledGlobe,
  geographicToDirection,
  resolveDatasetURL,
  subsolarPoint,
} from "tiled-globe";
import { BODIES, EARTH_SITES, bodyId, type BodyId } from "./bodies.ts";
import { loadOceanMask } from "./ocean.ts";
import { createPanel } from "./panel.ts";
import { loadStarBackground } from "./stars.ts";
import waterMaskURL from "./assets/ocean/water-mask.bin.gz?url";

const base = new URL(import.meta.env.BASE_URL, location.href).href;
const dataset = (path: string) => resolveDatasetURL(path, base, import.meta.env.VITE_TILE_BASE);

if (!("gpu" in navigator)) {
  const message = "This example requires WebGPU on HTTPS or localhost.";
  document.getElementById("startup-status")!.textContent = message;
  throw new Error(message);
}
const renderer = new THREE.WebGPURenderer({ antialias: true, reversedDepthBuffer: true });
// Full-screen shaders dominate near the surface; 2× Retina costs 1.8× the pixels of this.
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
await renderer.init();
document.body.append(renderer.domElement);

const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
labels.domElement.className = "places";
document.body.append(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 1e9);
void loadStarBackground().then((sky) => {
  scene.background = sky;
  scene.backgroundIntensity = 0.04;
});
const sun = new THREE.DirectionalLight(0xffffff, 3);
scene.add(sun, sun.target, new THREE.AmbientLight(0xffffff, 0.05));

let shown: { globe: TiledGlobe; controls: GlobeControls; dispose(): void } | undefined;
let latestShow = 0;

async function show(id: BodyId) {
  const request = ++latestShow;
  shown?.dispose();
  shown = undefined;
  panel.setNotice("");
  const body = BODIES[id];
  const waterMask =
    id === "earth" ? await loadOceanMask(waterMaskURL, new AbortController().signal) : undefined;
  if (request !== latestShow) return waterMask?.dispose();

  // Earth's imagery is a bright, saturated photo: AgX and the Moon's exposure wash it out.
  renderer.toneMapping = id === "earth" ? THREE.NeutralToneMapping : THREE.AgXToneMapping;
  renderer.toneMappingExposure = 2 ** body.exposureStops;
  const { longitudeDeg, latitudeDeg } = subsolarPoint(body.name, Date.now());
  geographicToDirection(latitudeDeg, longitudeDeg, sun.position);

  const globe = new TiledGlobe({
    name: body.name,
    radius: body.radiusMeters,
    flattening: "flattening" in body ? body.flattening : 0,
    sun,
    overview: body.overview,
    imagery: dataset(body.imagery),
    elevation: dataset(body.elevation),
    regions: "regions" in body ? dataset(body.regions) : undefined,
    // App-owned files, so they never go through the tile host.
    nightLights: "nightLights" in body ? new URL(body.nightLights, base).href : undefined,
    waterMask,
    hapke: id === "moon",
    surfaceDetail: id === "moon",
  });
  globe.addEventListener("error", ({ error }) => console.warn(`[${body.name}]`, error));
  scene.add(globe);
  camera.position.set(body.radiusMeters * 3, 0, 0);
  const controls = new GlobeControls(camera, renderer.domElement, globe);

  const grid = new Graticule();
  grid.visible = false;
  globe.add(grid);
  const toggles = [{ name: "Lat/long grid", object: grid as { visible: boolean } }];
  const owned: { dispose(): void }[] = [];
  const air = id === "earth" ? EARTH_AIR : id === "mars" ? MARS_AIR : undefined;
  if (air) {
    const atmosphere = new Atmosphere(air);
    globe.add(atmosphere);
    owned.push(atmosphere);
  }
  if ("coastline" in body) {
    const coastline = new GeoJsonOverlay({ data: body.coastline, color: "#ffd54a" });
    globe.add(coastline);
    toggles.push({ name: "USA coastline", object: coastline });
  }
  if ("clouds" in body) {
    const clouds = new Clouds({ map: new URL(body.clouds, base).href });
    globe.add(clouds);
    owned.push(clouds);
    toggles.push({ name: "Clouds", object: clouds });
  }
  if (id === "earth")
    for (const site of EARTH_SITES) {
      const element = document.createElement("span");
      element.textContent = site.label;
      element.className = "place";
      globe.add(new GlobeLabel(element, site.latitudeDeg, site.longitudeDeg));
    }

  shown = {
    globe,
    controls,
    dispose() {
      for (const object of owned) object.dispose();
      controls.dispose();
      scene.attach(camera);
      globe.dispose();
    },
  };
  panel.show(id, toggles);
  void globe.ready.then(() => {
    if (shown?.globe === globe && !globe.stats.imageryAvailable)
      panel.setNotice("Showing the bundled overview. Start tile-service for tiled imagery.");
  });
  const url = new URL(location.href);
  url.searchParams.set("body", id);
  history.replaceState(null, "", url);
}

const first = bodyId(new URLSearchParams(location.search).get("body"));
const panel = createPanel(first, (id) => void show(id));
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
});
await show(first);
document.getElementById("startup-status")?.remove();

const pipeline = createBloom(renderer, scene, camera);
renderer.setAnimationLoop(() => {
  if (!shown) return;
  shown.controls.update();
  shown.globe.update(camera, renderer);
  pipeline.render();
  labels.render(scene, camera);
  const { tiles, deepestLevel, imageryStatus, elevationStatus } = shown.globe.stats;
  const altitude = (shown.controls.altitude / 1000).toFixed(1);
  panel.setStats(
    `${tiles} tiles · level ${deepestLevel} · ${altitude} km\n${imageryStatus}\n${elevationStatus}`,
  );
});
