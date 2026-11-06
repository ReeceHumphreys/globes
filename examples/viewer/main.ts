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
import { loadStarBackground } from "../shared/star-background.ts";
import { ApolloLanders } from "../moon/rendering/landers.ts";
import { SurfaceRocks } from "../moon/rendering/rocks.ts";
import { LUNAR_PLACES } from "../moon/data/landmarks.ts";
import { MARKER_COUNTRIES } from "../moon/data/marker-countries.ts";
import { BODIES, EARTH_SITES, bodyId, type BodyId } from "./bodies.ts";
import { createPanel, type BodyControls } from "./panel.ts";
import { loadOceanMask } from "./ocean.ts";
import waterMaskURL from "./assets/ocean/water-mask.bin.gz?url";

const query = new URLSearchParams(location.search);
const base = new URL(import.meta.env.BASE_URL, location.href).href;
const dataset = (path: string) => resolveDatasetURL(path, base, import.meta.env.VITE_TILE_BASE);

// --- Renderer, scene, camera, lights: plain three.js ----------------------------------
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

// Labels are CSS2DObjects; GlobeLabels also hide themselves behind the horizon.
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
// One Sun for terrain and models. The globe sits at the origin, so world = body-fixed.
const sun = new THREE.DirectionalLight(0xffffff, 3);
scene.add(sun, sun.target, new THREE.AmbientLight(0xffffff, 0.05));
function setSun(longitudeDeg: number, latitudeDeg: number) {
  geographicToDirection(latitudeDeg, longitudeDeg, sun.position);
}

// --- One body at a time ----------------------------------------------------------------
interface Shown extends BodyControls {
  id: BodyId;
  controls: GlobeControls;
  update(): void;
  dispose(): void;
}
let shown: Shown | undefined;
let latestShow = 0;

async function show(id: BodyId) {
  const request = ++latestShow;
  shown?.dispose();
  shown = undefined;
  panel.setNotice("");
  const body = BODIES[id];
  // The wait happens before the globe exists, so a superseded call has little to undo.
  const waterMask =
    id === "earth"
      ? await loadOceanMask(waterMaskURL, new AbortController().signal).catch((error) => {
          console.warn("[Earth] Water mask unavailable", error);
          return undefined;
        })
      : undefined;
  if (request !== latestShow) {
    waterMask?.dispose();
    return;
  }
  // Earth's imagery is a bright, saturated photo: AgX and the Moon's exposure wash it out.
  renderer.toneMapping = id === "earth" ? THREE.NeutralToneMapping : THREE.AgXToneMapping;
  renderer.toneMappingExposure = 2 ** body.exposureStops;
  panel.setExposure(body.exposureStops);
  const globe = new TiledGlobe({
    name: body.name,
    radius: body.radiusMeters,
    flattening: "flattening" in body ? body.flattening : 0,
    sun,
    overview: body.overview,
    imagery: query.get("imagery") ?? dataset(body.imagery),
    elevation: query.get("heights") ?? dataset(body.elevation),
    regions: "regions" in body ? dataset(body.regions) : undefined,
    // App-owned file, so it never goes through the tile host.
    nightLights: "nightLights" in body ? new URL(body.nightLights, base).href : undefined,
    // Natural Earth ocean coverage, bundled with the example (see assets/ocean).
    waterMask,
    hapke: id === "moon",
    surfaceDetail: id === "moon",
  });
  globe.addEventListener("error", ({ error }) => console.warn(`[${body.name}]`, error));
  const air = id === "earth" ? EARTH_AIR : id === "mars" ? MARS_AIR : undefined;
  const atmosphere = air && new Atmosphere(air);
  if (atmosphere) globe.add(atmosphere);
  scene.add(globe);
  camera.position.set(body.radiusMeters * 3, 0, 0);
  const controls = new GlobeControls(camera, renderer.domElement, globe);
  const goTo = (latitudeDeg: number, longitudeDeg: number) => () =>
    controls.goTo(latitudeDeg, longitudeDeg, 20_000);
  const subsolar = subsolarPoint(body.name, Date.now());
  setSun(subsolar.longitudeDeg, subsolar.latitudeDeg);

  const extras: { update(): void; dispose(): void }[] = [];
  if (atmosphere) extras.push({ update() {}, dispose: () => atmosphere.dispose() });
  const places: Shown["places"] = [];
  const labelGroups: Shown["labelGroups"] = [];
  const grid = new Graticule({
    // The tropics and polar circles.
    parallels: id === "earth" ? [23.44, -23.44, 66.56, -66.56] : [],
  });
  grid.visible = false;
  globe.add(grid);
  labelGroups.push({ name: "Lat/long grid", group: grid });
  if ("coastline" in body) {
    const coastline = new GeoJsonOverlay({ data: body.coastline, color: "#ffd54a" });
    globe.add(coastline);
    labelGroups.push({ name: "USA coastline", group: coastline });
  }
  if ("clouds" in body) {
    const clouds = new Clouds({ map: new URL(body.clouds, base).href });
    globe.add(clouds);
    extras.push({ update() {}, dispose: () => clouds.dispose() });
    labelGroups.push({ name: "Clouds", group: clouds });
  }
  if (id === "moon") {
    // Rocks and Apollo landers ride the surface; place labels are grouped by country.
    const rocks = new SurfaceRocks(),
      landers = new ApolloLanders(base);
    globe.add(rocks, landers);
    extras.push(
      { update: () => rocks.update(camera, globe), dispose: () => rocks.dispose() },
      { update: () => landers.update(camera, globe), dispose: () => landers.dispose() },
    );
    for (const country of [...MARKER_COUNTRIES, { id: undefined, flag: "", label: "Other" }]) {
      const group = new THREE.Group();
      for (const place of LUNAR_PLACES.filter((p) => p.country === country.id))
        group.add(label(place.name, place.latitudeDeg, place.longitudeDeg, place.kind));
      globe.add(group);
      labelGroups.push({ name: `${country.flag} ${country.label}`.trim(), group });
    }
    for (const place of LUNAR_PLACES)
      places.push({ name: place.name, go: goTo(place.latitudeDeg, place.longitudeDeg) });
  }
  if (id === "earth") {
    for (const site of EARTH_SITES) {
      globe.add(label(site.label, site.latitudeDeg, site.longitudeDeg, "landmark"));
      places.push({ name: site.label, go: goTo(site.latitudeDeg, site.longitudeDeg) });
    }
  }

  shown = {
    id,
    globe,
    controls,
    places,
    labelGroups,
    sun: subsolar,
    update() {
      controls.update();
      globe.update(camera, renderer);
      for (const extra of extras) extra.update();
    },
    dispose() {
      for (const extra of extras) extra.dispose();
      controls.dispose();
      scene.attach(camera);
      globe.dispose();
    },
  };
  panel.show(id, shown);
  void globe.ready.then(() => {
    if (shown?.globe === globe && !globe.stats.imageryAvailable)
      panel.setNotice(
        "Tiled imagery unavailable: showing the bundled 2K overview. Start tile-service for detail.",
      );
  });
  const url = new URL(location.href);
  url.searchParams.set("body", id);
  history.replaceState(null, "", url);
}

const panel = createPanel({
  body: bodyId(query.get("body")),
  onBody: (id) => void show(id),
  onExposure: (stops) => (renderer.toneMappingExposure = 2 ** stops),
  onSun: setSun,
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
});
await show(bodyId(query.get("body")));
document.getElementById("startup-status")?.remove();

const pipeline = createBloom(renderer, scene, camera);
renderer.setAnimationLoop(() => {
  if (!shown) return;
  shown.update();
  pipeline.render();
  labels.render(scene, camera);
  const { stats } = shown.globe;
  panel.setStats(
    `${stats.tiles} tiles · level ${stats.deepestLevel} · ${(shown.controls.altitude / 1000).toFixed(1)} km\n${stats.imageryStatus}\n${stats.elevationStatus}`,
  );
});

// --- Helpers ---------------------------------------------------------------------------
function label(name: string, latitudeDeg: number, longitudeDeg: number, kind?: string) {
  const element = document.createElement("span");
  element.textContent = name;
  element.className = "place";
  if (kind) element.dataset.kind = kind;
  return new GlobeLabel(element, latitudeDeg, longitudeDeg);
}
