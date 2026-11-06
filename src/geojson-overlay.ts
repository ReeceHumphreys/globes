import * as THREE from "three/webgpu";
import {
  attribute,
  context as nodeContext,
  float,
  highpModelNormalViewMatrix,
  highpModelViewMatrix,
  mix,
  positionGeometry,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { GlobeLabel } from "./globe-label.ts";
import { fillPaths, readGeoJson, surfaceSegments, type GeoShapes } from "./geojson.ts";
import { ImageOverlay, SurfaceOverlay, type OverlayView } from "./overlay.ts";

export interface GeoJsonOverlayOptions {
  /** A GeoJSON object, or the URL of one. */
  data: string | object;
  /** Line and polygon outline colour. */
  color?: THREE.ColorRepresentation;
  /** Width in CSS pixels. */
  lineWidth?: number;
  /** Polygon fill. Omit to draw outlines only. */
  fill?: THREE.ColorRepresentation;
  fillOpacity?: number;
  opacity?: number;
  /** The marker for a Point. Defaults to a dot. */
  marker?: (properties: Record<string, unknown>) => HTMLElement;
}

const FILL_WIDTH = 4096;
// Lines sit on the surface, so a sightline ending there must not count as blocked.
const OCCLUDER_SCALE = 0.999;

/**
 * GeoJSON on a globe. Lines and outlines stay sharp and a constant width at any zoom.
 * Like other overlays they lie under clouds and haze: hide `Clouds` to see them all.
 * Points are GlobeLabels, so draw them with a CSS2DRenderer.
 *
 * One style per overlay: add one overlay for each style.
 */
export class GeoJsonOverlay extends SurfaceOverlay {
  override readonly type = "GeoJsonOverlay";
  readonly #options: GeoJsonOverlayOptions;
  readonly #fill?: { context: CanvasRenderingContext2D; image: ImageOverlay; map: THREE.Texture };
  readonly #eye = uniform(new THREE.Vector3());
  readonly #polarRatio = uniform(1);
  readonly #radius = uniform(1);
  #shapes?: GeoShapes;
  #lines?: LineSegments2;
  #disposed = false;

  constructor(options: GeoJsonOverlayOptions) {
    const { data, fill, opacity = 1 } = options;
    const painted = fill === undefined ? undefined : fillCanvas();
    super((surface) => painted?.image.paint(surface) ?? vec4(0), { opacity });
    this.name = "GeoJSON overlay";
    this.#options = options;
    this.#fill = painted;
    (typeof data === "string"
      ? fetch(data).then((response) => {
          if (!response.ok) throw new Error(`${response.status} ${data}`);
          return response.json() as Promise<unknown>;
        })
      : Promise.resolve(data)
    )
      .then((json) => {
        if (!this.#disposed) this.#show(readGeoJson(json));
      })
      // The globe is complete without its overlay.
      .catch((error: unknown) => console.warn("[GeoJsonOverlay]", error));
  }

  #show(shapes: GeoShapes) {
    this.#shapes = shapes;
    const { fill, fillOpacity = 0.3, marker = dot(this.#options.color) } = this.#options;
    for (const { position, properties } of shapes.points) {
      const [longitude, latitude, height] = position;
      const label =
        height === undefined
          ? new GlobeLabel(marker(properties), latitude, longitude)
          : new GlobeLabel(marker(properties), latitude, longitude, height, "ellipsoid");
      label.center.set(0.5, 0.5);
      this.add(label);
    }
    if (!this.#fill || fill === undefined) return;
    const { context, map } = this.#fill;
    const { width, height } = context.canvas;
    context.fillStyle = `#${new THREE.Color(fill).getHexString()}`;
    context.globalAlpha = fillOpacity;
    for (const rings of shapes.polygons) {
      context.beginPath();
      for (const path of fillPaths(rings))
        path.forEach(([longitude, latitude], i) => {
          const x = ((longitude + 180) / 360) * width,
            y = ((90 - latitude) / 180) * height;
          if (i === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
      // Even-odd leaves the holes empty, whichever way the rings wind.
      context.fill("evenodd");
    }
    map.needsUpdate = true;
  }

  #buildLines(view: OverlayView, shapes: GeoShapes) {
    const lines = [...shapes.lines, ...shapes.polygons.flat()];
    const positions = surfaceSegments(lines, view.radius, view.flattening);
    if (positions.length === 0) return;
    const { color = "#fff", lineWidth = 2 } = this.#options;
    const material = new THREE.Line2NodeMaterial({
      color,
      linewidth: lineWidth,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    // positionGeometry.x is ±1 at the line's sides: soften the last pixel.
    const edge = positionGeometry.x
      .abs()
      .oneMinus()
      .mul(lineWidth / 2)
      .clamp(0, 1);
    material.opacityNode = edge.mul(this.strength);
    material.contextNode = nodeContext({
      modelViewMatrix: highpModelViewMatrix,
      modelNormalViewMatrix: highpModelNormalViewMatrix,
    });
    // Without a depth test, hide what is behind the body. Stretched along the poles the
    // ellipsoid is a sphere, so one distance test covers both shapes.
    const stretch = vec3(1, float(1).div(this.#polarRatio), 1);
    const point = mix(
      attribute<"vec3">("instanceStart", "vec3"),
      attribute<"vec3">("instanceEnd", "vec3"),
      positionGeometry.y.clamp(0, 1),
    ).mul(stretch);
    const eye = this.#eye.mul(stretch);
    const ray = point.sub(eye);
    const closest = eye.add(ray.mul(eye.dot(ray).negate().div(ray.dot(ray)).clamp(0, 1)));
    const occluder = this.#radius.mul(OCCLUDER_SCALE);
    material.maskNode = closest.dot(closest).greaterThanEqual(occluder.mul(occluder));

    // shortcut: float32 positions, good to about half a meter on Earth, so lines shimmer
    // a few meters from the ground. Upgrade to camera-relative vertices if that matters.
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const object = new LineSegments2(geometry, material);
    object.name = "GeoJSON lines";
    object.frustumCulled = false;
    // Before the Atmosphere (-1), which then draws its haze and clouds over the lines.
    object.renderOrder = -2;
    object.raycast = () => {};
    this.#radius.value = view.radius;
    this.#polarRatio.value = 1 - view.flattening;
    this.#lines = object;
    this.add(object);
  }

  override update(view: OverlayView): void {
    super.update(view);
    this.#eye.value.copy(view.camera);
    if (this.#shapes && !this.#lines) this.#buildLines(view, this.#shapes);
  }

  override dispose(): void {
    this.#disposed = true;
    this.#lines?.geometry.dispose();
    (this.#lines?.material as THREE.Material | undefined)?.dispose();
    this.#fill?.image.dispose();
    super.dispose();
  }
}

function fillCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = FILL_WIDTH;
  canvas.height = FILL_WIDTH / 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas for GeoJSON fills");
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return { context, image: new ImageOverlay({ map }), map };
}

const dot =
  (color: THREE.ColorRepresentation = "#fff") =>
  () => {
    const element = document.createElement("div");
    element.style.cssText = `width:8px;height:8px;border-radius:50%;background:#${new THREE.Color(color).getHexString()}`;
    return element;
  };
