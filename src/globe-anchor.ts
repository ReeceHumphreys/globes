import { Group } from "three/webgpu";

/**
 * A group fixed to a point on the globe, for vehicles, pads and anything else near the
 * surface. Its children are in local meters: x east, y up, z south, so a Y-up glTF model
 * stands on the ground. Add it to a {@link TiledGlobe}, which places it on every update.
 *
 * Set `renderer.highPrecision = true` so children stay stable to centimeters. Without it,
 * three.js multiplies view and world matrices in 32-bit floats on the GPU, which jitters
 * by about half a meter at Earth's radius.
 */
export class GlobeAnchor extends Group {
  readonly isGlobeAnchor = true;
  /** Geodetic latitude, degrees. */
  latitude: number;
  /** East-positive longitude, degrees. */
  longitude: number;
  /** Meters above `altitudeReference`. */
  altitude: number;
  /** What `altitude` is measured from. Terrain follows tiles as they stream in. */
  altitudeReference: "terrain" | "ellipsoid";

  constructor(
    latitude: number,
    longitude: number,
    altitude = 0,
    altitudeReference: "terrain" | "ellipsoid" = "terrain",
  ) {
    super();
    if (
      !Number.isFinite(latitude) ||
      Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(altitude)
    )
      throw new RangeError("Invalid anchor position.");
    this.latitude = latitude;
    this.longitude = longitude;
    this.altitude = altitude;
    this.altitudeReference = altitudeReference;
  }
}
