import type { TiledGlobe } from "tiled-globe";
import { BODIES, BODY_IDS, type BodyId } from "./bodies.ts";

export interface PanelOptions {
  body: BodyId;
  onBody(id: BodyId): void;
  onExposure(stops: number): void;
  /** Subsolar point, degrees. */
  onSun(longitudeDeg: number, latitudeDeg: number): void;
}
export interface BodyControls {
  globe: TiledGlobe;
  /** Named places: picking one flies there. */
  places: { name: string; go(): void }[];
  /** Label groups, toggled by their visibility. */
  labelGroups: { name: string; group: { visible: boolean } }[];
  sun: { longitudeDeg: number; latitudeDeg: number };
}

const DISPLAY = {
  imagery: "Tiled imagery",
  overview: "Overview image",
  terrain: "Neutral terrain",
  checker: "Checker",
};
const TOGGLES = [
  ["shading", "Sun shading"],
  ["terrainShadows", "Terrain shadows"],
  ["displacement", "Terrain elevation"],
  ["hapke", "Hapke reflectance"],
  ["wireframe", "Wireframe"],
] as const;

/** A small HTML panel. Terrain inputs read and write the globe's own properties. */
export function createPanel(options: PanelOptions) {
  const panel = document.createElement("aside");
  panel.className = "panel";
  panel.innerHTML = `
    <p>
      ${BODY_IDS.map((id) => `<button type="button" class="system-button" data-body="${id}" aria-pressed="${id === options.body}">${BODIES[id].name}</button>`).join("")}
    </p>
    <p>Drag to orbit, scroll to zoom toward the cursor, right-drag or Shift-drag to look around.</p>
    <label>Places <select data-places></select></label>
    <p class="marker-countries" data-groups></p>
    <label>Surface <select data-display>
      ${Object.entries(DISPLAY)
        .map(([value, text]) => `<option value="${value}">${text}</option>`)
        .join("")}
    </select></label>
    ${TOGGLES.map(([key, text]) => `<label><input type="checkbox" data-toggle="${key}"> ${text}</label>`).join("")}
    <label>Shadow steps <input type="range" data-shadow-steps min="8" max="48" step="4"></label>
    <label>Sun longitude <input type="range" data-sun-lon min="-180" max="180" step="1"></label>
    <label>Sun latitude <input type="range" data-sun-lat min="-90" max="90" step="1"></label>
    <label>Exposure <input type="range" data-exposure min="-2" max="5" step="0.25" value="2"></label>
    <small data-notice></small>
    <small data-credit></small>
    <small data-stats></small>
  `;
  document.body.append(panel);
  const $ = <T extends Element>(selector: string) => panel.querySelector<T>(selector)!;
  const sunLon = $<HTMLInputElement>("[data-sun-lon]"),
    sunLat = $<HTMLInputElement>("[data-sun-lat]");
  let globe: TiledGlobe | null = null;

  panel.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-body]")?.dataset.body;
    if (id) options.onBody(id as BodyId);
  });
  panel.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement & HTMLSelectElement;
    if (target.matches("[data-exposure]")) options.onExposure(Number(target.value));
    if (target.matches("[data-sun-lon], [data-sun-lat]"))
      options.onSun(Number(sunLon.value), Number(sunLat.value));
    if (!globe) return;
    if (target.matches("[data-display]")) globe.display = target.value as TiledGlobe["display"];
    if (target.matches("[data-shadow-steps]")) globe.shadowSteps = Number(target.value);
    const key = target.dataset.toggle as (typeof TOGGLES)[number][0] | undefined;
    if (key) globe[key] = target.checked;
  });

  function syncGlobe(next: TiledGlobe) {
    $<HTMLSelectElement>("[data-display]").value = next.display;
    $<HTMLInputElement>("[data-shadow-steps]").value = String(next.shadowSteps);
    for (const [key] of TOGGLES) $<HTMLInputElement>(`[data-toggle="${key}"]`).checked = next[key];
  }

  return {
    /** Bind the terrain controls to a newly shown body. */
    show(id: BodyId, controls: BodyControls) {
      globe = controls.globe;
      const body = BODIES[id];
      $("[data-credit]").textContent = "credit" in body ? body.credit : "";
      for (const button of panel.querySelectorAll<HTMLElement>("[data-body]"))
        button.setAttribute("aria-pressed", String(button.dataset.body === id));
      syncGlobe(controls.globe);
      // The default surface depends on which data loads; show it once it has.
      void controls.globe.ready.then(() => {
        if (globe === controls.globe) syncGlobe(controls.globe);
      });
      sunLon.value = String(Math.round(controls.sun.longitudeDeg));
      sunLat.value = String(Math.round(controls.sun.latitudeDeg));
      const select = $<HTMLSelectElement>("[data-places]");
      select.parentElement!.hidden = !controls.places.length;
      select.replaceChildren(
        new Option("Go to…", ""),
        ...controls.places.map((place, i) => new Option(place.name, String(i))),
      );
      select.onchange = () => controls.places[Number(select.value)]?.go();
      $<HTMLElement>("[data-groups]").replaceChildren(
        ...controls.labelGroups.map(({ name, group }) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = name;
          button.setAttribute("aria-pressed", String(group.visible));
          button.onclick = () => {
            group.visible = !group.visible;
            button.setAttribute("aria-pressed", String(group.visible));
          };
          return button;
        }),
      );
    },
    setNotice(text: string) {
      $("[data-notice]").textContent = text;
    },
    setStats(text: string) {
      $("[data-stats]").textContent = text;
    },
  };
}
