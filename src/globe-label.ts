import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

/**
 * An HTML label pinned to a geographic position on a TiledGlobe.
 *
 * Add it to the globe (directly or inside untransformed groups) and draw it with three's
 * CSS2DRenderer. Each `globe.update()` lifts the label onto the displayed
 * terrain and hides it behind the horizon, so `visible` belongs to the globe:
 * hide labels with a parent group instead.
 */
export class GlobeLabel extends CSS2DObject {
  readonly isGlobeLabel = true;
  /** Planetocentric latitude, degrees. */
  latitude: number;
  /** East-positive longitude, degrees. */
  longitude: number;
  /** Meters above the displayed terrain. */
  altitude: number;

  constructor(element: HTMLElement, latitude: number, longitude: number, altitude = 0) {
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
    // Anchor the label's bottom center on the point.
    this.center.set(0.5, 1);
  }
}
