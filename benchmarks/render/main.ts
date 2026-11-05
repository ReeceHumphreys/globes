// One render case per page load, set by the query string. Run with `npm run benchmark:render`.
// Same scene as the viewer without tile-service: overview, night lights, water, atmosphere.
import * as THREE from "three/webgpu";
import {
  GeoJsonOverlay,
  Graticule,
  ImageOverlay,
  Atmosphere,
  Clouds,
  createBloom,
  EARTH_AIR,
  GlobeControls,
  MARS_AIR,
  TiledGlobe,
} from "tiled-globe";
import { BODIES, bodyId } from "../../examples/viewer/bodies.ts";
import { loadOceanMask } from "../../examples/viewer/ocean.ts";
import waterMaskURL from "../../examples/viewer/assets/ocean/water-mask.bin.gz?url";

const query = new URLSearchParams(location.search);
const number = (name: string, fallback: number) => Number(query.get(name) ?? fallback);
const id = bodyId(query.get("body"));
const body = BODIES[id];
const altitude = number("altitude", 20_000);
const tilt = number("tilt", 0);
const moving = query.get("moving") !== "0";
const frames = number("frames", 120);

async function run() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, reversedDepthBuffer: true });
  renderer.toneMapping = id === "earth" ? THREE.NeutralToneMapping : THREE.AgXToneMapping;
  renderer.toneMappingExposure = 2 ** body.exposureStops;
  renderer.setPixelRatio(number("pixelRatio", 2));
  renderer.setSize(number("width", 1728), number("height", 1117));
  await renderer.init();
  document.body.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    60,
    renderer.domElement.width / renderer.domElement.height,
    1,
    1e9,
  );
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(1, 0.3, 0.2);
  scene.add(sun, sun.target, new THREE.AmbientLight(0xffffff, 0.05));
  const globe = new TiledGlobe({
    name: body.name,
    radius: body.radiusMeters,
    flattening: "flattening" in body ? body.flattening : 0,
    sun,
    overview: body.overview,
    imagery: query.get("tiles") === "1" ? `/${body.imagery}` : undefined,
    elevation: query.get("tiles") === "1" && "elevation" in body ? `/${body.elevation}` : undefined,
    nightLights: "nightLights" in body ? `/${body.nightLights}` : undefined,
    waterMask:
      id === "earth" ? await loadOceanMask(waterMaskURL, new AbortController().signal) : undefined,
    hapke: id === "moon",
    surfaceDetail: id === "moon",
  });
  if (query.get("atmosphere") !== "0" && id !== "moon")
    globe.add(new Atmosphere(id === "earth" ? EARTH_AIR : MARS_AIR));
  const clouds =
    query.get("clouds") === "1" && "clouds" in body
      ? new Clouds({ map: `/${body.clouds}` })
      : undefined;
  if (clouds) globe.add(clouds);
  scene.add(globe);
  camera.position.set(body.radiusMeters * 3, 0, 0);
  const controls = new GlobeControls(camera, renderer.domElement, globe);
  await globe.ready;
  while (clouds && !clouds.map) await new Promise((resolve) => setTimeout(resolve, 50));

  if (query.get("grid") === "1") globe.add(new Graticule());
  if (query.get("image") === "1") {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 1024;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f00";
    // Latitudes 20 to 40 north, longitudes 0 to 30 east.
    context.fillRect(1024, 284, 171, 114);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    globe.add(new ImageOverlay({ map, opacity: 0.6 }));
  }
  if (query.get("geojson") === "1")
    globe.add(
      new GeoJsonOverlay({
        color: "#ff0",
        fill: "#0af",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [0, 20],
                    [30, 20],
                    [30, 40],
                    [0, 40],
                    [0, 20],
                  ],
                  [
                    [10, 25],
                    [20, 25],
                    [20, 35],
                    [10, 35],
                    [10, 25],
                  ],
                ],
              },
            },
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: [
                  [-60, 0],
                  [60, 60],
                  [120, 10],
                ],
              },
            },
          ],
        },
      }),
    );
  if (query.get("geojson") === "usa")
    globe.add(new GeoJsonOverlay({ data: BODIES.earth.coastline, color: "#ffd54a" }));
  if (query.get("geojson") === "heavy") {
    // About the size of Natural Earth's 10m coastlines.
    const coordinates = Array.from({ length: 400 }, (_, line) => {
      let longitude = -170 + (line % 20) * 17,
        latitude = -70 + Math.floor(line / 20) * 7;
      return Array.from({ length: 1000 }, (_, i) => {
        longitude += Math.sin(i * 0.7 + line) * 0.02 + 0.012;
        latitude += Math.cos(i * 0.5 + line) * 0.02;
        return [longitude, latitude];
      });
    });
    globe.add(new GeoJsonOverlay({ data: { type: "MultiLineString", coordinates } }));
  }
  const pipeline = query.get("bloom") === "1" ? createBloom(renderer, scene, camera) : undefined;
  const device = (renderer.backend as unknown as { device: GPUDevice }).device;
  // A fast drag: about a tenth of the altitude of ground per frame.
  const stepDeg = moving ? ((altitude * 0.1) / body.radiusMeters) * (180 / Math.PI) : 0;
  let longitude = number("longitude", 10);
  async function frame() {
    // A render pass draws once per animation frame, however often it is asked.
    if (pipeline || query.has("raf")) await new Promise(requestAnimationFrame);
    const started = performance.now();
    longitude = ((longitude + stepDeg + 180) % 360) - 180;
    controls.goTo(number("latitude", 20), longitude, altitude);
    controls.update();
    camera.rotateX(tilt);
    camera.updateMatrixWorld(true);
    globe.update(camera, renderer);
    if (pipeline) pipeline.render();
    else renderer.render(scene, camera);
    const submitted = performance.now();
    await device.queue.onSubmittedWorkDone();
    return { total: performance.now() - started, cpu: submitted - started };
  }

  // Warm up past pipeline compilation and the first tile selection.
  for (let i = 0; i < 30; i++) await frame();
  // What adding and removing an overlay costs mid-session: each recompiles the terrain.
  let overlayAdded: number | undefined, overlayRemoved: number | undefined;
  if (query.get("grid") === "late") {
    const grid = new Graticule();
    globe.add(grid);
    overlayAdded = (await frame()).total;
    grid.dispose();
    overlayRemoved = (await frame()).total;
  }
  const samples: { total: number; cpu: number }[] = [];
  for (let i = 0; i < frames; i++) samples.push(await frame());
  const sorted = (key: "total" | "cpu") => samples.map((s) => s[key]).sort((a, b) => a - b);
  const at = (values: number[], p: number) => values[Math.floor((values.length - 1) * p)];
  const total = sorted("total");
  return {
    overlayAdded,
    overlayRemoved,
    median: at(total, 0.5),
    p95: at(total, 0.95),
    cpu: at(sorted("cpu"), 0.5),
    tiles: globe.stats.tiles,
    gpu: `${device.adapterInfo.vendor} ${device.adapterInfo.architecture}`,
    pixels: renderer.domElement.width * renderer.domElement.height,
  };
}

const page = window as unknown as { benchmark: Promise<unknown> };
page.benchmark = run();
// Readable when opened by hand, as in Safari, which the script cannot drive.
void page.benchmark.then((result) => {
  document.title = JSON.stringify(result);
  const output = document.createElement("pre");
  output.style.color = "#fff";
  output.textContent = JSON.stringify(result, null, 2);
  document.body.prepend(output);
});
