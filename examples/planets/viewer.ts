import { resolveDatasetURL } from "tiled-globe";
import {
  TextureLoader,
  NoColorSpace,
  RepeatWrapping,
  ClampToEdgeWrapping,
  type Texture,
} from "three/webgpu";
import { loadCloudNoise } from "./cloud-noise.ts";
import cloudShapeURL from "./assets/clouds/shape.bin?url";
import cloudDetailURL from "./assets/clouds/shape-detail.bin?url";
import cloudLicenseURL from "./assets/clouds/LICENSE.txt?url";
import cloudWeatherURL from "./assets/earth-clouds-2048.jpg?url";
import oceanMaskURL from "./assets/ocean/water-mask.bin.gz?url";
import { loadOceanMask } from "./ocean.ts";
import {
  createGlobe,
  createMarkerLayer,
  createSunLayer,
  subsolarPoint,
  tiledSurface,
  type Globe,
  type SurfaceLayer,
} from "tiled-globe";
import { createStarSkyLayer } from "../shared/star-sky.ts";
import { addQuerySpacecraft, sunFollowsClock } from "../shared/spacecraft.ts";
import { BODIES, EARTH_SITES, type BodyId } from "./bodies.ts";
import {
  MARS_DUST_PRESETS,
  MARS_EXPOSURE_STOPS,
  MARS_VIEWS,
  marsSunForView,
  marsDustPreset,
} from "./mars-presentation.ts";
import {
  handoffDistance,
  isHeld,
  LEAVE_RADII,
  type Arrival,
  type Departure,
  type HeldStart,
} from "./zoom.ts";

/** Earth and Mars use the same engine, with no lunar reflectance or models. */
export async function startPlanetViewer(
  id: Exclude<BodyId, "moon">,
  arrival?: Arrival | HeldStart,
  onLeave?: (pose: Departure) => void,
): Promise<() => void> {
  const held = isHeld(arrival);
  const body = BODIES[id];
  const query = new URLSearchParams(location.search);
  const dustPreset = marsDustPreset(query.get("marsDust"));
  const exposureStops = id === "mars" ? MARS_EXPOSURE_STOPS : 0;
  let sunLongitude = id === "mars" ? marsSunForView(MARS_VIEWS.orbit).longitude : 0;
  let sunLatitude = id === "mars" ? marsSunForView(MARS_VIEWS.orbit).latitude : 0;
  if (arrival && !held) {
    const sun = subsolarPoint(body.name, arrival.timeMs);
    sunLongitude = Math.round(sun.longitudeDeg);
    sunLatitude = Math.round(sun.latitudeDeg);
  }
  const asset = (path: string) => new URL(import.meta.env.BASE_URL + path, location.href).href;
  const dataset = (path: string) =>
    resolveDatasetURL(
      path,
      new URL(import.meta.env.BASE_URL, location.href).href,
      import.meta.env.VITE_TILE_BASE,
    );
  const imagery = query.get("imagery") ?? dataset(body.imagery);
  const heights = query.get("heights") ?? (body.elevation ? dataset(body.elevation) : undefined);
  const container = document.createElement("div");
  container.className = "globe-container";
  if (held) container.style.visibility = "hidden";
  document.body.append(container);
  const sun = createSunLayer({ angularDiameterDegrees: id === "mars" ? 0.35 : 0.533 });
  const siteMarkers =
    id === "earth"
      ? createMarkerLayer(
          Object.entries(EARTH_SITES).map(([siteId, site]) => ({
            id: siteId,
            label: site.label,
            latitudeDeg: site.latitudeDeg,
            longitudeDeg: site.longitudeDeg,
          })),
          {
            className: "places",
            createElement(site) {
              const node = document.createElement("span");
              node.textContent = site.label;
              node.title = `${site.label}\n${site.latitudeDeg}°, ${site.longitudeDeg}° east`;
              return node;
            },
          },
        )
      : undefined;
  const atmosphere = (await import("./atmosphere.ts")).createPlanetAtmosphere(
    id,
    body.radiusMeters,
    id === "mars" ? { marsDustOpticalDepth: MARS_DUST_PRESETS[dustPreset].opticalDepth } : {},
  );
  let globe: Globe;
  try {
    globe = await createGlobe({
      container,
      body,
      surface: tiledSurface({
        imagery,
        ...("nightLights" in body ? { nightLights: asset(body.nightLights) } : {}),
        ...("regions" in body ? { regions: query.get("regions") ?? dataset(body.regions) } : {}),
        ...(heights ? { elevation: { tiles: heights } } : {}),
      }),
      layers: [createStarSkyLayer(), sun, ...(siteMarkers ? [siteMarkers] : [])],
      exposureStops,
      environment: atmosphere,
    });
  } catch (error) {
    atmosphere.dispose();
    container.remove();
    throw error;
  }
  const cloudController = new AbortController();
  // With spacecraft loaded, their clock owns the Sun; manual Sun controls are disabled.
  let clockDriven = false;
  let stopClock: (() => void) | undefined;
  let noise: Awaited<ReturnType<typeof loadCloudNoise>> | undefined;
  let weather: Texture | undefined;
  let oceanMask: Texture | undefined;
  let closed = false;
  if (id === "earth") {
    void loadOceanMask(oceanMaskURL, cloudController.signal)
      .then((loaded) => {
        if (closed) {
          loaded.dispose();
          return;
        }
        oceanMask = loaded;
        atmosphere.setOceanMask(loaded);
      })
      .catch((error: unknown) => {
        if (!closed) console.error("[Globes] Ocean mask failed to load", error);
      });
    void loadCloudNoise(cloudShapeURL, cloudDetailURL, cloudController.signal)
      .then((loaded) => {
        if (closed) {
          loaded.dispose();
          return;
        }
        noise = loaded;
        atmosphere.setCloudNoise(loaded);
      })
      .catch((error: unknown) => {
        if (!closed) console.error("[Globes] Cloud noise failed to load", error);
      });
    void new TextureLoader()
      .loadAsync(cloudWeatherURL)
      .then((loaded) => {
        if (closed) {
          loaded.dispose();
          return;
        }
        loaded.colorSpace = NoColorSpace;
        loaded.flipY = false; // Source rows run from north to south.
        loaded.wrapS = RepeatWrapping;
        loaded.wrapT = ClampToEdgeWrapping;
        weather = loaded;
        atmosphere.setCloudWeather(loaded);
      })
      .catch((error: unknown) => {
        if (!closed) console.error("[Globes] Cloud weather failed to load", error);
      });
  }
  globe.setShading(true);
  globe.setSun(sunLongitude, sunLatitude);
  if (id === "mars")
    globe.goTo(MARS_VIEWS.orbit.latitude, MARS_VIEWS.orbit.longitude, MARS_VIEWS.orbit.altitude);
  const panel = document.createElement("aside");
  panel.className = "panel";
  panel.innerHTML = `<strong>${body.name} globe</strong>
    <p>Drag the globe · Scroll or pinch to zoom toward cursor · Scroll out to the solar system · Double-click to zoom · Right-drag or Shift-drag to look around</p>
    <label>Surface layer<select data-layer aria-label="Surface layer">
      <option value="imagery">Tiled imagery</option><option value="terrain">Neutral terrain</option>
      <option value="checker">Numbered checkerboard</option></select></label>
    <label><input type="checkbox" data-atmosphere checked> Atmosphere · experimental WebGPU</label>
    <label><input type="checkbox" data-surface-haze checked> Haze over terrain</label>
    <small>Turn off terrain haze to compare the imagery. Sky scattering stays enabled; this comparison mode is not a complete physical view.</small>
    ${
      id === "earth"
        ? `<label><input type="checkbox" data-clouds checked> Volumetric clouds · experimental</label>
    <label><input type="checkbox" data-oceans> Ocean reflections</label>
    <label>Water roughness <span data-ocean-roughness-value>0.27</span>
      <input type="range" data-ocean-roughness min="0.08" max="0.6" step="0.01" value="0.27" aria-label="Water roughness"></label>
    <small>Ocean coastline mask: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a>. Lower roughness sharpens Sun glint. Night lights: <a href="https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/" target="_blank" rel="noopener noreferrer">NASA Black Marble 2016</a>, Suomi NPP VIIRS. They glow on the dark side; haze and clouds cover them.</small>
    <label>Earth sites<select data-earth-site aria-label="Earth sites"><option value="">Choose a site…</option>${Object.entries(
      EARTH_SITES,
    )
      .map(([key, site]) => `<option value="${key}">${site.label}</option>`)
      .join("")}</select></label>
    <small>USDA NAIP photographs, about 2 km across, on the cloudless pyramid. Starbase is the launch site. Kennedy Space Center is LC-39A. Turn clouds off if they cover the pad.</small>
    <label>Cloud amount <span data-cloud-coverage-value>48%</span>
      <input type="range" data-cloud-coverage min="0" max="1" step="0.01" value="0.48" aria-label="Cloud amount"></label>
    <label>Cloud quality<select data-cloud-quality aria-label="Cloud quality">
      <option value="low">Low · 48 steps</option><option value="medium" selected>Medium · 96 steps</option><option value="high">High · 160 steps</option></select></label>
    <small>NASA Blue Marble cloud composite · static, not live weather. Credit: NASA/GSFC, Reto Stöckli. Higher quality costs more GPU time. <a href="${cloudLicenseURL}" target="_blank" rel="noopener noreferrer">Cloud rendering licenses</a>.</small>`
        : ""
    }
    ${
      id === "mars"
        ? `<label>Mars atmosphere<select data-mars-dust aria-label="Mars dust conditions">${Object.entries(
            MARS_DUST_PRESETS,
          )
            .map(
              ([key, preset]) =>
                `<option value="${key}" ${key === dustPreset ? "selected" : ""}>${preset.label}</option>`,
            )
            .join("")}</select></label>
    <label>Explore Mars<select data-mars-view aria-label="Explore Mars">${Object.entries(MARS_VIEWS)
      .map(([key, view]) => `<option value="${key}">${view.label}</option>`)
      .join("")}</select></label>`
        : ""
    }
    <label>Exposure <span data-exposure-value>${exposureStops.toFixed(1)} stops</span>
      <input type="range" data-exposure min="-2" max="5" step="0.1" value="${exposureStops}" aria-label="Exposure"></label>
    <label><input type="checkbox" data-elevation disabled> Terrain elevation</label>
    <label><input type="checkbox" data-shading checked> Terrain sunlight shading</label>
    <label><input type="checkbox" data-shadows checked disabled> Terrain blocks sunlight</label>
    <label>Terrain shadow quality<select data-shadow-quality aria-label="Terrain shadow quality">
      <option value="12">Low · 12 samples</option><option value="24" selected>Medium · 24 samples</option>
      <option value="48">High · 48 samples</option></select></label>
    <label><input type="checkbox" data-normal-cache checked> Cache settled terrain normals</label>
    <label><input type="checkbox" data-sunlight-cache checked> Cache terrain sunlight</label>
    <p data-cache-status></p>
    <p data-clock hidden></p>
    <label>Sun longitude <span data-sun-lon-value>${sunLongitude}°</span>
      <input type="range" data-sun-lon min="-180" max="180" step="1" value="${sunLongitude}" aria-label="Sun longitude"></label>
    <label>Sun latitude <span data-sun-lat-value>${sunLatitude}°</span>
      <input type="range" data-sun-lat min="-90" max="90" step="1" value="${sunLatitude}" aria-label="Sun latitude"></label>
    <label><input type="checkbox" data-sun-flare checked> Sun lens flare</label>
    ${id === "mars" ? `<small>Mars dust · illustrative uniform profile · optical depth ${MARS_DUST_PRESETS[dustPreset].opticalDepth} at 550 nm. No measured weather. Warm color and contrast are a presentation grade over the colorized Viking mosaic, not calibrated albedo.</small>` : ""}
    <small data-sun-note>Photographic imagery already contains illumination. Use neutral terrain to inspect lighting. Shadows use loaded elevation. The Sun position is illustrative, not date-driven.</small>
    <label><input type="checkbox" data-wireframe> Wireframe</label>
    <label>Inspect altitude<select data-altitude><option value="">Choose a view…</option>
      <option value="${body.radiusMeters * 2}">Orbit</option><option value="10000">Region · 10 km</option>
      <option value="10">Surface · 10 m</option></select></label>
    <p data-data role="status"></p><p data-stats></p>
    <small>This example uses a spherical reference body. Terrain follows the global elevation grid when available. ${body.name} atmosphere is experimental${id === "mars" ? " · approximate dust preset" : ""}${id === "earth" ? "; satellite-guided clouds are available" : "; clouds are not configured"}.</small>
    <details><summary>Dataset and credits</summary><p data-credit></p><a data-source target="_blank" rel="noopener noreferrer">Source dataset</a></details>`;
  document.body.append(panel);
  if (held) panel.style.visibility = "hidden";
  let timeMs = !held && arrival ? arrival.timeMs : Date.now();
  let leave = onLeave;
  function place(next: Arrival) {
    if (Math.hypot(next.x, next.y, next.z) > 0) {
      globe.camera.position.set(next.x, next.y, next.z);
      globe.camera.position.setLength(handoffDistance(body.radiusMeters, next.distanceMeters));
    }
    const sunPoint = subsolarPoint(body.name, next.timeMs);
    const lon = Math.round(sunPoint.longitudeDeg);
    const lat = Math.round(sunPoint.latitudeDeg);
    timeMs = next.timeMs;
    globe.setSun(lon, lat);
    panel.querySelector<HTMLInputElement>("[data-sun-lon]")!.value = String(lon);
    panel.querySelector<HTMLInputElement>("[data-sun-lat]")!.value = String(lat);
    panel.querySelector("[data-sun-lon-value]")!.textContent = `${lon}°`;
    panel.querySelector("[data-sun-lat-value]")!.textContent = `${lat}°`;
    panel.querySelector("[data-sun-note]")!.textContent =
      "The Sun matches the solar-system time. Move the sliders to override it. Photographic imagery already contains illumination.";
    globe.render();
    container.style.visibility = "";
    panel.style.visibility = "";
  }
  if (arrival && !held) place(arrival);
  const onChange = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.matches("[data-mars-dust]")) {
      const url = new URL(location.href);
      url.searchParams.set("marsDust", target.value);
      location.assign(url);
    }
    if (target.matches("[data-earth-site]") && Object.hasOwn(EARTH_SITES, target.value)) {
      const site = EARTH_SITES[target.value as keyof typeof EARTH_SITES];
      globe.goTo(site.latitudeDeg, site.longitudeDeg, 10000);
      if (clockDriven) return;
      sunLongitude = Math.round(site.longitudeDeg);
      sunLatitude = 15;
      globe.setSun(sunLongitude, sunLatitude);
      panel.querySelector<HTMLInputElement>("[data-sun-lon]")!.value = String(sunLongitude);
      panel.querySelector<HTMLInputElement>("[data-sun-lat]")!.value = String(sunLatitude);
      panel.querySelector<HTMLElement>("[data-sun-lon-value]")!.textContent = `${sunLongitude}°`;
      panel.querySelector<HTMLElement>("[data-sun-lat-value]")!.textContent = `${sunLatitude}°`;
    }
    if (target.matches("[data-mars-view]") && Object.hasOwn(MARS_VIEWS, target.value)) {
      const view = MARS_VIEWS[target.value as keyof typeof MARS_VIEWS];
      globe.goTo(view.latitude, view.longitude, view.altitude);
      if (clockDriven) return;
      ({ longitude: sunLongitude, latitude: sunLatitude } = marsSunForView(view));
      globe.setSun(sunLongitude, sunLatitude);
      panel.querySelector<HTMLInputElement>("[data-sun-lon]")!.value = String(sunLongitude);
      panel.querySelector<HTMLInputElement>("[data-sun-lat]")!.value = String(sunLatitude);
      panel.querySelector<HTMLElement>("[data-sun-lon-value]")!.textContent = `${sunLongitude}°`;
      panel.querySelector<HTMLElement>("[data-sun-lat-value]")!.textContent = `${sunLatitude}°`;
    }
    if (target.matches("[data-clouds]")) atmosphere.setCloudsEnabled(target.checked);
    if (target.matches("[data-oceans]")) atmosphere.setOceansEnabled(target.checked);
    if (target.matches("[data-cloud-quality]"))
      atmosphere.setCloudQuality(target.value as import("./clouds.ts").CloudQuality);
    if (target.matches("[data-surface-haze]")) atmosphere.setSurfaceHaze(target.checked);
    if (target.matches("[data-atmosphere]")) {
      atmosphere.setEnabled(target.checked);
      for (const input of panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "[data-clouds], [data-cloud-coverage], [data-cloud-quality], [data-oceans], [data-ocean-roughness]",
      ))
        input.disabled = !target.checked;
    }
    if (target.matches("[data-layer]")) globe.setSurfaceLayer(target.value as SurfaceLayer);
    if (target.matches("[data-shading]")) globe.setShading(target.checked);
    if (target.matches("[data-elevation]")) globe.setElevationEnabled(target.checked);
    if (target.matches("[data-shadows]")) globe.setTerrainShadows(target.checked);
    if (target.matches("[data-shadow-quality]")) globe.setShadowSteps(Number(target.value));
    if (target.matches("[data-normal-cache]")) globe.setNormalCacheEnabled(target.checked);
    if (target.matches("[data-sunlight-cache]")) globe.setSunlightCacheEnabled(target.checked);
    if (target.matches("[data-sun-flare]")) sun.setFlareEnabled(target.checked);
    if (target.matches("[data-wireframe]")) globe.setWireframe(target.checked);
    if (target.matches("[data-altitude]") && target.value) globe.setAltitude(Number(target.value));
  };
  const onInput = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.matches("[data-ocean-roughness]")) {
      atmosphere.setOceanRoughness(Number(target.value));
      panel.querySelector<HTMLElement>("[data-ocean-roughness-value]")!.textContent = Number(
        target.value,
      ).toFixed(2);
    }
    if (target.matches("[data-cloud-coverage]")) {
      atmosphere.setCloudCoverage(Number(target.value));
      panel.querySelector<HTMLElement>("[data-cloud-coverage-value]")!.textContent =
        `${Math.round(Number(target.value) * 100)}%`;
    }
    if (target.matches("[data-exposure]")) {
      const stops = Number(target.value);
      globe.setExposure(stops);
      panel.querySelector<HTMLElement>("[data-exposure-value]")!.textContent =
        `${stops >= 0 ? "+" : ""}${stops.toFixed(1)} stops`;
    }
    if (target.matches("[data-sun-lon], [data-sun-lat]")) {
      const longitude = Number(panel.querySelector<HTMLInputElement>("[data-sun-lon]")!.value);
      const latitude = Number(panel.querySelector<HTMLInputElement>("[data-sun-lat]")!.value);
      panel.querySelector<HTMLElement>("[data-sun-lon-value]")!.textContent = `${longitude}°`;
      panel.querySelector<HTMLElement>("[data-sun-lat-value]")!.textContent = `${latitude}°`;
      globe.setSun(longitude, latitude);
    }
  };
  panel.addEventListener("input", onInput);
  panel.addEventListener("change", onChange);
  const data = panel.querySelector<HTMLElement>("[data-data]")!;
  if (!globe.stats.imageryAvailable) {
    panel.querySelector<HTMLSelectElement>("[data-layer]")!.value = "terrain";
    data.textContent = `Tiles are not ready at ${imagery}. Finish generating them, then reload, or supply ?body=${id}&imagery=/your/manifest.json.`;
  }
  let elevationAvailable = false;
  const unsubscribe = globe.onFrame((stats) => {
    if (elevationAvailable !== stats.elevationAvailable) {
      elevationAvailable = stats.elevationAvailable;
      const input = panel.querySelector<HTMLInputElement>("[data-elevation]")!;
      input.disabled = !elevationAvailable;
      input.checked = elevationAvailable;
      panel.querySelector<HTMLInputElement>("[data-shadows]")!.disabled = !elevationAvailable;
    }
    const cache = stats.terrainCaches;
    panel.querySelector<HTMLElement>("[data-cache-status]")!.textContent = cache
      ? `Terrain caches · ${cache.gradientReady}/${cache.gradientSlots} gradients · ${cache.sunlightReady}/${cache.sunlightSlots} sunlight · ${(cache.bytes / 1048576).toFixed(2)} MiB · ${cache.state}`
      : "Terrain caches · awaiting tiled elevation";
    if (stats.imageryAvailable)
      data.textContent = heights
        ? `${stats.imageryStatus} · ${stats.elevationStatus}`
        : stats.imageryStatus;
    panel.querySelector<HTMLElement>("[data-stats]")!.textContent =
      `${(stats.altitudeMeters / 1000).toFixed(1)} km altitude · ${stats.tiles} tiles · level ${stats.deepestLevel} · ${stats.selectionMs.toFixed(2)} ms selection`;
    document.getElementById("startup-status")?.remove();
    if (
      leave &&
      container.style.visibility !== "hidden" &&
      globe.camera.position.length() > body.radiusMeters * LEAVE_RADII
    ) {
      const report = leave;
      leave = undefined;
      report({
        x: globe.camera.position.x,
        y: globe.camera.position.y,
        z: globe.camera.position.z,
        timeMs,
      });
    }
  });
  // Display attribution from the same manifest; do not inject downloaded HTML.
  const controller = new AbortController();
  void fetch(imagery, { signal: controller.signal })
    .then((r) => (r.ok ? r.json() : undefined))
    .then((manifest) => {
      if (!manifest || controller.signal.aborted) return;
      panel.querySelector<HTMLElement>("[data-credit]")!.textContent =
        manifest.source?.credit ?? manifest.title ?? body.name;
      const link = panel.querySelector<HTMLAnchorElement>("[data-source]")!;
      const source = new URL(manifest.source?.page ?? "", location.href);
      if (manifest.source?.page && ["https:", "http:"].includes(source.protocol))
        link.href = source.href;
      else link.hidden = true;
    })
    .catch(() => {});
  void addQuerySpacecraft(query, globe, cloudController.signal)
    .then((layer) => {
      if (!layer || closed) return;
      clockDriven = true;
      const clock = panel.querySelector<HTMLElement>("[data-clock]")!;
      clock.hidden = false;
      const longitude = panel.querySelector<HTMLInputElement>("[data-sun-lon]")!;
      const latitude = panel.querySelector<HTMLInputElement>("[data-sun-lat]")!;
      longitude.disabled = latitude.disabled = true;
      panel.querySelector<HTMLElement>("[data-sun-note]")!.textContent =
        "The Sun follows the spacecraft clock (solar ephemeris, about 0.01°). Clouds are a static composite, not weather for this date.";
      let shown = "";
      stopClock = sunFollowsClock(globe, layer, body.name, (timeMs, sun) => {
        const text = `${new Date(timeMs).toISOString().slice(0, 19).replace("T", " ")} UTC · ${layer.getRate()}×`;
        if (text === shown) return;
        shown = text;
        clock.textContent = text;
        longitude.value = String(Math.round(sun.longitudeDeg));
        latitude.value = String(Math.round(sun.latitudeDeg));
        panel.querySelector<HTMLElement>("[data-sun-lon-value]")!.textContent =
          `${sun.longitudeDeg.toFixed(1)}°`;
        panel.querySelector<HTMLElement>("[data-sun-lat-value]")!.textContent =
          `${sun.latitudeDeg.toFixed(1)}°`;
      });
    })
    .catch((error: unknown) => {
      if (!closed) console.warn("[Globes] Spacecraft data failed", error);
    });
  globe.requestRender();
  const stop = () => {
    closed = true;
    stopClock?.();
    cloudController.abort();
    controller.abort();
    unsubscribe();
    panel.removeEventListener("change", onChange);
    panel.removeEventListener("input", onInput);
    panel.remove();
    globe.dispose();
    weather?.dispose();
    noise?.dispose();
    oceanMask?.dispose();
    container.remove();
  };
  if (held) arrival.ready(place);
  return stop;
}
