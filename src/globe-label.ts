import type { Object3D } from "three/webgpu";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

/** A CSS2D label removes its element only when it is removed itself. Walk a detached ancestor too. */
export function removeLabelElements(root: Object3D): void {
  root.traverse((object) => {
    if ("isCSS2DObject" in object) (object as unknown as { element: Element }).element.remove();
  });
}

/**
 * An HTML label pinned to a geographic position on a TiledGlobe.
 *
 * Add it to the globe (directly or inside untransformed groups) and draw it with three's
 * CSS2DRenderer. Each `globe.update()` lifts the label onto the displayed
 * terrain and hides it behind the horizon, so `visible` belongs to the globe:
 * hide labels with a parent group instead.
 */
export class GlobeLabel extends CSS2DObject {
  /** @internal */
  readonly isGlobeLabel = true;
  /** Latitude in degrees, geodetic on a flattened globe. */
  latitude: number;
  /** East-positive longitude, degrees. */
  longitude: number;
  /** Meters above `altitudeReference`. */
  altitude: number;
  /** What `altitude` is measured from. */
  altitudeReference: "terrain" | "ellipsoid";

  constructor(
    element: HTMLElement,
    latitude: number,
    longitude: number,
    altitude = 0,
    altitudeReference: "terrain" | "ellipsoid" = "terrain",
  ) {
    super(element);
    if (
      !Number.isFinite(latitude) ||
      Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(altitude)
    )
      throw new RangeError("Invalid label position");
    this.latitude = latitude;
    this.longitude = longitude;
    this.altitude = altitude;
    this.altitudeReference = altitudeReference;
    // Anchor the label's bottom center on the point.
    this.center.set(0.5, 1);
  }
}
