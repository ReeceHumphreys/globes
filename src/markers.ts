import { Vector3, type PerspectiveCamera } from "three/webgpu";
import type { GlobeContext, GlobeFrame, GlobeLayer } from "./composition.ts";
import { sunDirection } from "./rendering/sun.ts";

export interface GeographicPosition {
  latitudeDeg: number;
  longitudeDeg: number;
}
export interface GlobeMarker extends GeographicPosition {
  id: string;
  label: string;
  /** Optional application-defined visibility group. */
  group?: string;
  /** Meters above the displayed terrain; zero by default. */
  heightOffsetMeters?: number;
}
export interface MarkerProjection {
  x: number;
  y: number;
  visible: boolean;
}
export function geographicDirection(position: GeographicPosition): [number, number, number] {
  return sunDirection(
    (position.longitudeDeg * Math.PI) / 180,
    (position.latitudeDeg * Math.PI) / 180,
  );
}

/** Reusable projection state: update the camera once, then project many markers. */
export function createMarkerProjector() {
  const projected = new Vector3();
  let camera: PerspectiveCamera,
    radius = 0,
    width = 0,
    height = 0;
  return {
    begin(next: PerspectiveCamera, radiusMeters: number, viewWidth: number, viewHeight: number) {
      camera = next;
      radius = radiusMeters;
      width = viewWidth;
      height = viewHeight;
      camera.updateMatrixWorld();
    },
    projectDirection(
      dx: number,
      dy: number,
      dz: number,
      surfaceMeters: number,
      out: MarkerProjection,
    ) {
      out.visible = false;
      out.x = out.y = 0;
      if (width < 1 || height < 1) return out;
      const distance = radius + surfaceMeters;
      const px = dx * distance,
        py = dy * distance,
        pz = dz * distance;
      const cx = camera.position.x,
        cy = camera.position.y,
        cz = camera.position.z;
      // Conservative spherical-horizon test. This is not terrain-depth occlusion.
      if (dx * (cx - px) + dy * (cy - py) + dz * (cz - pz) <= 0) return out;
      const basis = camera.matrixWorld.elements;
      if ((px - cx) * -basis[8] + (py - cy) * -basis[9] + (pz - cz) * -basis[10] <= 0) return out;
      projected.set(px, py, pz).project(camera);
      out.x = (projected.x * 0.5 + 0.5) * width;
      out.y = (-projected.y * 0.5 + 0.5) * height;
      out.visible = projected.x >= -1 && projected.x <= 1 && projected.y >= -1 && projected.y <= 1;
      return out;
    },
  };
}
export function projectMarker(
  position: GeographicPosition,
  camera: PerspectiveCamera,
  radius: number,
  width: number,
  height: number,
  surfaceMeters = 0,
): MarkerProjection {
  const projector = createMarkerProjector();
  projector.begin(camera, radius, width, height);
  return projector.projectDirection(...geographicDirection(position), surfaceMeters, {
    x: 0,
    y: 0,
    visible: false,
  });
}
export interface MarkerLayerOptions<T extends GlobeMarker> {
  id?: string;
  className?: string;
  /** Called once per marker during attach; use textContent for untrusted text. */
  createElement?: (marker: Readonly<T>) => HTMLElement;
}

/** DOM labels for small catalogs; planetary datasets and presentation stay in the app. */
export function createMarkerLayer<T extends GlobeMarker>(
  markers: readonly T[],
  options: MarkerLayerOptions<T> = {},
) {
  const ids = new Set<string>();
  const records = markers.map((marker) => {
    if (!marker.id || ids.has(marker.id))
      throw new Error(`Duplicate or empty marker id: ${marker.id}`);
    if (
      !Number.isFinite(marker.latitudeDeg) ||
      Math.abs(marker.latitudeDeg) > 90 ||
      !Number.isFinite(marker.longitudeDeg) ||
      Math.abs(marker.longitudeDeg) > 180 ||
      !Number.isFinite(marker.heightOffsetMeters ?? 0)
    )
      throw new RangeError(`Invalid marker position: ${marker.id}`);
    ids.add(marker.id);
    return { ...marker };
  });
  const directions = new Float64Array(records.length * 3);
  records.forEach((marker, i) => directions.set(geographicDirection(marker), i * 3));
  const disabledGroups = new Set<string>(),
    disabledMarkers = new Set<string>();
  const projector = createMarkerProjector(),
    projected = { x: 0, y: 0, visible: false };
  let context: GlobeContext | undefined, root: HTMLElement | undefined;
  const nodes: HTMLElement[] = [];
  const shown = new Uint8Array(records.length),
    positions = new Float64Array(records.length * 2).fill(NaN);
  function setVisible(set: Set<string>, key: string, visible: boolean) {
    if (visible) set.delete(key);
    else set.add(key);
    context?.requestRender();
  }
  return {
    id: options.id ?? "markers",
    attach(next: GlobeContext) {
      context = next;
      root = document.createElement("div");
      root.className = options.className ?? "globe-markers";
      Object.assign(root.style, {
        position: "absolute",
        inset: "0",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: "1",
        color: "#fff",
        font: "12px sans-serif",
        textShadow: "0 1px 2px #000",
      });
      for (const marker of records) {
        const node = options.createElement?.(marker) ?? document.createElement("span");
        if (!options.createElement) {
          node.textContent = marker.label;
          node.style.transform = "translate(-50%, -100%)";
          node.style.whiteSpace = "nowrap";
        }
        node.dataset.markerId = marker.id;
        Object.assign(node.style, { position: "absolute", left: "0", top: "0" });
        node.hidden = true;
        node.style.visibility = "hidden";
        root.append(node);
        nodes.push(node);
      }
      next.container.append(root);
    },
    update({ context }: GlobeFrame) {
      projector.begin(
        context.camera,
        context.body.radiusMeters,
        context.viewport.width,
        context.viewport.height,
      );
      for (let i = 0; i < records.length; i++) {
        const marker = records[i],
          j = i * 3;
        let visible =
          !disabledMarkers.has(marker.id) && !(marker.group && disabledGroups.has(marker.group));
        if (visible) {
          const x = directions[j],
            y = directions[j + 1],
            z = directions[j + 2];
          // Reject the far side before sampling terrain (which may touch the height cache).
          const camera = context.camera.position;
          projected.visible = false;
          if (x * camera.x + y * camera.y + z * camera.z > 0)
            projector.projectDirection(
              x,
              y,
              z,
              context.sampleHeight(x, y, z) + (marker.heightOffsetMeters ?? 0),
              projected,
            );
          visible = projected.visible;
        }
        if (shown[i] !== Number(visible)) {
          nodes[i].hidden = !visible;
          // Author CSS such as display:flex can override the HTML hidden rule.
          nodes[i].style.visibility = visible ? "visible" : "hidden";
          shown[i] = Number(visible);
        }
        if (!visible) continue;
        // Subpixel precision without redundant style writes on unchanged frames.
        const k = i * 2;
        const x = Math.round(projected.x * 100) / 100;
        const y = Math.round(projected.y * 100) / 100;
        if (positions[k] !== x || positions[k + 1] !== y) {
          nodes[i].style.translate = `${x}px ${y}px`;
          positions[k] = x;
          positions[k + 1] = y;
        }
      }
    },
    setGroupVisible(group: string, visible: boolean) {
      setVisible(disabledGroups, group, visible);
    },
    setMarkerVisible(id: string, visible: boolean) {
      if (!ids.has(id)) throw new Error(`Unknown marker id: ${id}`);
      setVisible(disabledMarkers, id, visible);
    },
    dispose() {
      root?.remove();
      root = undefined;
      nodes.length = 0;
      context = undefined;
    },
  } satisfies GlobeLayer & {
    setGroupVisible(group: string, visible: boolean): void;
    setMarkerVisible(id: string, visible: boolean): void;
  };
}
