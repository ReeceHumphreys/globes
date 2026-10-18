import { DEFAULT_SUN_LATITUDE_DEG, DEFAULT_SUN_LONGITUDE_DEG } from "tiled-globe";
import { LUNAR_PLACES } from "./data/landmarks.ts";
import { DEFAULT_EXPOSURE_STOPS } from "./config.ts";
import { MARKER_COUNTRIES, type MarkerCountry } from "./data/marker-countries.ts";

export type SurfaceLayer = "moon" | "checker" | "wac" | "terrain";

export function createPanel(options: {
  wacAvailable: boolean;
  elevationAvailable: boolean;
  onExposure: (stops: number) => void;
  onHapke: (enabled: boolean) => void;
  onNormalCache: (enabled: boolean) => void;
  onSunlightCache: (enabled: boolean) => void;
  onTerrainShadows: (enabled: boolean) => void;
  onShadowQuality: (steps: number) => void;
  onShading: (enabled: boolean) => void;
  onWireframe: (enabled: boolean) => void;
  onAltitude: (meters: number) => void;
  onImagery: (layer: SurfaceLayer) => void;
  onElevation: (enabled: boolean) => void;
  onSun: (longitudeDeg: number, latitudeDeg: number) => void;
  onSunFlare: (enabled: boolean) => void;
  onSite: (index: number) => void;
  onMarkerCountry: (country: MarkerCountry, visible: boolean) => void;
}) {
  const panel = document.createElement("aside");
  panel.className = "panel";
  panel.innerHTML = `
    <strong>Lunar globe</strong>
    <p>Drag the globe · Scroll or pinch to zoom toward cursor · Scroll out to the solar system · Double-click to zoom · Right-drag or Shift-drag to look around</p>
    <fieldset class="marker-countries">
      <legend>Mission markers</legend>
      ${MARKER_COUNTRIES.filter((country) =>
        LUNAR_PLACES.some((place) => place.country === country.id),
      )
        .map(
          (country) =>
            `<button type="button" data-marker-country="${country.id}" aria-label="${country.name} mission markers" aria-pressed="true" title="${country.name}"><span aria-hidden="true" class="country-flag">${country.flag}</span> ${country.label}</button>`,
        )
        .join("")}
    </fieldset>
    <label>Surface layer
      <select data-layer aria-label="Surface layer">
        <option value="wac" ${options.wacAvailable ? "selected" : "disabled"}>WAC tiled imagery${options.wacAvailable ? "" : " (not generated)"}</option>
        <option value="moon" ${options.wacAvailable ? "" : "selected"}>NASA lunar color</option>
        <option value="terrain">Neutral terrain · lighting inspection</option>
        <option value="checker">Numbered checkerboard</option>
      </select>
    </label>
    <label>Exposure <span data-exposure-value></span>
      <input type="range" data-exposure min="-2" max="5" step="0.1" value="${DEFAULT_EXPOSURE_STOPS}" aria-label="Exposure">
    </label>
    <label>Inspect altitude
      <select data-altitude aria-label="Inspect altitude">
        <option value="">Choose a view…</option>
        <option value="3474800">Orbit · 3,475 km</option>
        <option value="10000">Region · 10 km</option>
        <option value="10">Surface · 10 m</option>
      </select>
    </label>
    <label>Go to location
      <select data-site aria-label="Go to location">
        <option value="">Choose a location…</option>
        ${["Apollo", "Robotic landings", "Landmarks"]
          .map(
            (group, groupIndex) =>
              `<optgroup label="${group}">${LUNAR_PLACES.map((site, i) => {
                const category = site.kind === "landmark" ? 2 : site.kind === "landing" ? 1 : 0;
                return category === groupIndex
                  ? `<option value="${i}">${site.name}${site.accuracy && site.accuracy !== "localized" ? " · approximate location" : ""}</option>`
                  : "";
              }).join("")}</optgroup>`,
          )
          .join("")}
      </select>
    </label>
    <p data-place-detail hidden aria-live="polite"></p>
    <label><input type="checkbox" data-elevation ${options.elevationAvailable ? "checked" : "disabled"}> Terrain elevation</label>
    <label><input type="checkbox" data-shading checked> Terrain sunlight shading</label>
    <label><input type="checkbox" data-hapke checked> Hapke surface reflectance</label>
    <label><input type="checkbox" data-shadows checked> Terrain blocks sunlight</label>
    <label><input type="checkbox" data-normal-cache checked> Cache settled terrain normals</label>
    <label><input type="checkbox" data-sunlight-cache checked> Cache terrain sunlight</label>
    <p data-cache-status></p>
    <label>Terrain shadow quality
      <select data-shadow-quality aria-label="Terrain shadow quality"><option value="12">Low · 12 samples</option><option value="24" selected>Medium · 24 samples</option><option value="48">High · 48 samples</option></select>
    </label>
    <small>Use neutral terrain to inspect lighting. Photographic layers already contain shadows. Terrain shadows use loaded elevation; fine or distant occluders can be missed.</small>
    <label>Sun longitude <span data-sun-lon-value></span>
      <input type="range" data-sun-lon min="-180" max="180" step="1" aria-label="Sun longitude">
    </label>
    <label>Sun latitude <span data-sun-lat-value></span>
      <input type="range" data-sun-lat min="-90" max="90" step="1" aria-label="Sun latitude">
    </label>
    <label><input type="checkbox" data-sun-flare checked> Sun lens flare</label>
    <label><input type="checkbox" data-wireframe> Wireframe</label>
    <p data-elevation-status></p>
    <p data-imagery aria-live="polite"></p>
    <p data-stats aria-live="polite"></p>
    <details>
      <summary>Credits</summary>
      <small>
        Overview: <a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">NASA SVS / LRO</a>.
        2K visualization map, not calibrated science data.
        Elevation: NASA SVS / LOLA, relative to a 1,737.4 km sphere.
        WAC mosaic: LROC Team / ASU / USGS.
        Stars: <a href="https://svs.gsfc.nasa.gov/3895/" target="_blank" rel="noreferrer">NASA/Goddard Space Flight Center Scientific Visualization Studio</a>,
        Deep Star Maps (2012). Sky orientation is illustrative.
        Landing sites: <a href="https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_artifact_impacts.html" target="_blank" rel="noreferrer">NASA NSSDCA</a>.
        White: Apollo · blue: successful robotic landings · gold: landmarks.
        Some historic positions are approximate. Rover markers denote their landing sites.
      </small>
    </details>
  `;
  const normalCache = panel.querySelector<HTMLInputElement>("[data-normal-cache]")!;
  const sunlightCache = panel.querySelector<HTMLInputElement>("[data-sunlight-cache]")!;
  const onNormalCache = () => options.onNormalCache(normalCache.checked);
  const onSunlightCache = () => options.onSunlightCache(sunlightCache.checked);
  normalCache.addEventListener("change", onNormalCache);
  sunlightCache.addEventListener("change", onSunlightCache);
  const hapke = panel.querySelector<HTMLInputElement>("[data-hapke]")!;
  const markerCountries = panel.querySelector<HTMLFieldSetElement>(".marker-countries")!;
  const onMarkerCountry = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(
      "button[data-marker-country]",
    );
    if (!button) return;
    const visible = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(visible));
    options.onMarkerCountry(button.dataset.markerCountry as MarkerCountry, visible);
  };
  markerCountries.addEventListener("click", onMarkerCountry);
  const exposure = panel.querySelector<HTMLInputElement>("[data-exposure]")!;
  const exposureValue = panel.querySelector("[data-exposure-value]")!;
  const showExposure = () => {
    const stops = Number(exposure.value);
    exposureValue.textContent = `${stops >= 0 ? "+" : ""}${stops.toFixed(1)} stops`;
  };
  showExposure();
  const onExposure = () => {
    showExposure();
    options.onExposure(Number(exposure.value));
  };
  exposure.addEventListener("input", onExposure);
  const sunFlare = panel.querySelector<HTMLInputElement>("[data-sun-flare]")!;
  const shadows = panel.querySelector<HTMLInputElement>("[data-shadows]")!;
  const shadowQuality = panel.querySelector<HTMLSelectElement>("[data-shadow-quality]")!;
  const shading = panel.querySelector<HTMLInputElement>("[data-shading]")!;
  const wireframe = panel.querySelector<HTMLInputElement>("[data-wireframe]")!;
  const elevation = panel.querySelector<HTMLInputElement>("[data-elevation]")!;
  const layer = panel.querySelector<HTMLSelectElement>("[data-layer]")!;
  const altitude = panel.querySelector<HTMLSelectElement>("[data-altitude]")!;
  const site = panel.querySelector<HTMLSelectElement>("[data-site]")!;
  const sunLongitude = panel.querySelector<HTMLInputElement>("[data-sun-lon]")!;
  const sunLatitude = panel.querySelector<HTMLInputElement>("[data-sun-lat]")!;
  const sunLongitudeValue = panel.querySelector("[data-sun-lon-value]")!;
  const sunLatitudeValue = panel.querySelector("[data-sun-lat-value]")!;
  sunLongitude.value = String(DEFAULT_SUN_LONGITUDE_DEG);
  sunLatitude.value = String(DEFAULT_SUN_LATITUDE_DEG);
  const showSun = () => {
    sunLongitudeValue.textContent = `${sunLongitude.value}°`;
    sunLatitudeValue.textContent = `${sunLatitude.value}°`;
  };
  showSun();
  const onHapke = () => options.onHapke(hapke.checked);
  const onSunFlare = () => options.onSunFlare(sunFlare.checked);
  const onShadows = () => options.onTerrainShadows(shadows.checked);
  const onShadowQuality = () => options.onShadowQuality(Number(shadowQuality.value));
  const onShading = () => options.onShading(shading.checked);
  const onWireframe = () => options.onWireframe(wireframe.checked);
  const onElevation = () => options.onElevation(elevation.checked);
  const onLayer = () => options.onImagery(layer.value as SurfaceLayer);
  const onAltitude = () => {
    if (altitude.value) options.onAltitude(Number(altitude.value));
    altitude.value = "";
  };
  const onSun = () => {
    showSun();
    options.onSun(Number(sunLongitude.value), Number(sunLatitude.value));
  };
  const onSite = () => {
    if (site.value !== "") {
      const index = Number(site.value);
      options.onSite(index);
      const place = LUNAR_PLACES[index]!;
      const detail = panel.querySelector<HTMLParagraphElement>("[data-place-detail]")!;
      detail.textContent = `${place.name}${place.detail ? ` — ${place.detail}` : ""}.`;
      if (place.sourceUrl) {
        const link = document.createElement("a");
        link.href = place.sourceUrl;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = " Location source";
        detail.append(link);
      }
      detail.hidden = false;
    }
    site.value = "";
  };
  hapke.addEventListener("change", onHapke);
  sunFlare.addEventListener("change", onSunFlare);
  shadows.addEventListener("change", onShadows);
  shadowQuality.addEventListener("change", onShadowQuality);
  shading.addEventListener("change", onShading);
  wireframe.addEventListener("change", onWireframe);
  elevation.addEventListener("change", onElevation);
  layer.addEventListener("change", onLayer);
  altitude.addEventListener("change", onAltitude);
  site.addEventListener("change", onSite);
  sunLongitude.addEventListener("input", onSun);
  sunLatitude.addEventListener("input", onSun);
  const stats = panel.querySelector("[data-stats]")!;
  document.body.appendChild(panel);
  return {
    setTerrainCacheStatus(text: string) {
      panel.querySelector("[data-cache-status]")!.textContent = text;
    },
    setElevationAvailable(available: boolean) {
      elevation.disabled = !available;
      elevation.checked = available;
    },
    setElevationStatus(text: string) {
      panel.querySelector("[data-elevation-status]")!.textContent = text;
    },
    setImageryStatus(text: string) {
      panel.querySelector("[data-imagery]")!.textContent = text;
    },
    update(
      tiles: number,
      triangles: number,
      milliseconds: number,
      altitudeMeters: number,
      deepest: number,
    ) {
      stats.textContent = `${altitudeMeters.toLocaleString(undefined, { maximumFractionDigits: 1 })} m above terrain · level ${deepest} · ${tiles.toLocaleString()} tiles · ${triangles.toLocaleString()} triangles · ${milliseconds.toFixed(2)} ms`;
    },
    dispose() {
      normalCache.removeEventListener("change", onNormalCache);
      sunlightCache.removeEventListener("change", onSunlightCache);
      markerCountries.removeEventListener("click", onMarkerCountry);
      exposure.removeEventListener("input", onExposure);
      hapke.removeEventListener("change", onHapke);
      sunFlare.removeEventListener("change", onSunFlare);
      shadows.removeEventListener("change", onShadows);
      shadowQuality.removeEventListener("change", onShadowQuality);
      shading.removeEventListener("change", onShading);
      wireframe.removeEventListener("change", onWireframe);
      elevation.removeEventListener("change", onElevation);
      layer.removeEventListener("change", onLayer);
      altitude.removeEventListener("change", onAltitude);
      site.removeEventListener("change", onSite);
      sunLongitude.removeEventListener("input", onSun);
      sunLatitude.removeEventListener("input", onSun);
      panel.remove();
    },
  };
}
