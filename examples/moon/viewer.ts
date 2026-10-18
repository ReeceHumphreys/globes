import { resolveDatasetURL } from "tiled-globe";
import {
  createMarkerLayer,
  createGlobe,
  createSunLayer,
  createSunEnvironment,
  subsolarPoint,
  tiledSurface,
  type Globe,
  type SurfaceLayer,
} from "tiled-globe";
import { MOON_RADIUS_M, DEFAULT_EXPOSURE_STOPS } from "./config.ts";
import {
  handoffDistance,
  isHeld,
  LEAVE_RADII,
  type Arrival,
  type Departure,
  type HeldStart,
} from "../planets/zoom.ts";
import { createPanel } from "./panel.ts";
import { LUNAR_PLACES } from "./data/landmarks.ts";
import { apolloLayer, moonSkyLayer, rockLayer } from "./rendering/scene-layers.ts";
import overviewURL from "./rendering/lroc-color-2k.jpg";

/** Moon-specific composition. The npm library owns the generic globe engine. */
export async function startViewer(
  arrival?: Arrival | HeldStart,
  onLeave?: (pose: Departure) => void,
): Promise<() => void> {
  const held = isHeld(arrival);
  const container = document.createElement("div");
  container.className = "globe-container";
  if (held) container.style.visibility = "hidden";
  document.body.append(container);
  const asset = (path: string) =>
    new URL(import.meta.env.BASE_URL + path, window.location.href).href;
  const dataset = (path: string) =>
    resolveDatasetURL(
      path,
      new URL(import.meta.env.BASE_URL, location.href).href,
      import.meta.env.VITE_TILE_BASE,
    );
  const query = new URLSearchParams(window.location.search);
  const sunLayer = createSunLayer();
  const markers = createMarkerLayer(
    LUNAR_PLACES.map((place, index) => ({
      ...place,
      id: String(index),
      label: place.name,
      group: place.country,
    })),
    {
      className: "places",
      createElement(place) {
        const node = document.createElement("span");
        node.textContent = place.name;
        if (place.kind === "landmark") node.dataset.landmark = "";
        if (place.kind) node.dataset.kind = place.kind;
        node.title =
          place.name +
          (place.detail ? " — " + place.detail : "") +
          "\n" +
          place.latitudeDeg +
          "°, " +
          place.longitudeDeg +
          "° east";
        return node;
      },
    },
  );
  let globe: Globe;
  try {
    globe = await createGlobe({
      container,
      body: { name: "Moon", radiusMeters: MOON_RADIUS_M },
      surface: tiledSurface({
        overview: overviewURL,
        imagery: query.get("imagery") ?? dataset("data/moon/wac/manifest.json"),
        regions: query.get("regions") ?? dataset("data/moon/apollo/catalog.json"),
        elevation: {
          tiles: query.get("heights") ?? dataset("data/moon/elevation-tiles/manifest.json"),
          global: dataset("data/moon/elevation/manifest.json"),
        },
        hapke: true,
        surfaceDetail: true,
      }),
      environment: createSunEnvironment(),
      layers: [moonSkyLayer(), sunLayer, rockLayer(), apolloLayer(asset("")), markers],
      exposureStops: DEFAULT_EXPOSURE_STOPS,
    });
  } catch (error) {
    container.remove();
    throw error;
  }
  const panel = createPanel({
    wacAvailable: globe.stats.imageryAvailable,
    elevationAvailable: globe.stats.elevationAvailable,
    onMarkerCountry(country, visible) {
      markers.setGroupVisible(country, visible);
      globe.requestRender();
    },
    onExposure: globe.setExposure,
    onNormalCache: globe.setNormalCacheEnabled,
    onSunlightCache: globe.setSunlightCacheEnabled,
    onHapke: globe.setHapke,
    onTerrainShadows: globe.setTerrainShadows,
    onShadowQuality: globe.setShadowSteps,
    onShading: globe.setShading,
    onWireframe: globe.setWireframe,
    onAltitude: globe.setAltitude,
    onImagery(layer) {
      const layers = {
        moon: "overview",
        wac: "imagery",
        terrain: "terrain",
        checker: "checker",
      } as const;
      globe.setSurfaceLayer(layers[layer] as SurfaceLayer);
    },
    onElevation: globe.setElevationEnabled,
    onSun: globe.setSun,
    onSunFlare(enabled) {
      sunLayer.setFlareEnabled(enabled);
      globe.requestRender();
    },
    onSite(index) {
      const site = LUNAR_PLACES[index];
      if (site) globe.goTo(site.latitudeDeg, site.longitudeDeg);
    },
  });
  const panelEl = document.body.querySelector<HTMLElement>("aside.panel:last-of-type");
  if (held && panelEl) panelEl.style.visibility = "hidden";
  let timeMs = !held && arrival ? arrival.timeMs : Date.now();
  let leave = onLeave;
  function place(next: Arrival) {
    if (Math.hypot(next.x, next.y, next.z) > 0) {
      globe.camera.position.set(next.x, next.y, next.z);
      globe.camera.position.setLength(handoffDistance(MOON_RADIUS_M, next.distanceMeters));
    }
    const sun = subsolarPoint("Moon", next.timeMs);
    const lon = Math.round(sun.longitudeDeg);
    const lat = Math.round(sun.latitudeDeg);
    timeMs = next.timeMs;
    globe.setSun(lon, lat);
    const lonInput = panelEl?.querySelector<HTMLInputElement>("[data-sun-lon]");
    const latInput = panelEl?.querySelector<HTMLInputElement>("[data-sun-lat]");
    if (lonInput && latInput && panelEl) {
      lonInput.value = String(lon);
      latInput.value = String(lat);
      panelEl.querySelector("[data-sun-lon-value]")!.textContent = `${lon}°`;
      panelEl.querySelector("[data-sun-lat-value]")!.textContent = `${lat}°`;
    }
    globe.render();
    container.style.visibility = "";
    if (panelEl) panelEl.style.visibility = "";
  }
  if (arrival && !held) place(arrival);
  let elevationAvailable = globe.stats.elevationAvailable;
  const unsubscribe = globe.onFrame((stats) => {
    if (elevationAvailable !== stats.elevationAvailable) {
      elevationAvailable = stats.elevationAvailable;
      panel.setElevationAvailable(elevationAvailable);
    }
    panel.update(
      stats.tiles,
      stats.triangles,
      stats.selectionMs,
      stats.altitudeMeters,
      stats.deepestLevel,
    );
    const cache = stats.terrainCaches;
    panel.setTerrainCacheStatus(
      cache
        ? `Terrain caches · ${cache.gradientReady}/${cache.gradientSlots} gradients · ${cache.sunlightReady}/${cache.sunlightSlots} sunlight patches · ${(cache.bytes / 1048576).toFixed(2)} MiB · ${cache.state}`
        : "Terrain caches · awaiting tiled elevation",
    );
    panel.setImageryStatus(stats.imageryStatus);
    panel.setElevationStatus(stats.elevationStatus);
    document.getElementById("startup-status")?.remove();
    if (
      leave &&
      container.style.visibility !== "hidden" &&
      globe.camera.position.length() > MOON_RADIUS_M * LEAVE_RADII
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
  let disposed = false;
  globe.requestRender();
  const stop = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    panel.dispose();
    globe.dispose();
    container.remove();
  };
  if (held) arrival.ready(place);
  return stop;
}
