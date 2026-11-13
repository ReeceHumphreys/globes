import { MathUtils, Vector3 } from "three/webgpu";
import { GlobeAnchor } from "./globe-anchor.ts";

/** Masks the terrain can hide at once. */
export const MAX_TERRAIN_MASKS = 8;

const _east = new Vector3(),
  _north = new Vector3();

/**
 * Hides the globe's terrain inside a rectangle on the ground, so a 3D Tiles scan or a
 * model of a pad sits on clean ground instead of the coarser terrain showing through.
 * The rectangle is `width` meters east-west and `length` meters north-south before it
 * turns by `heading`, and reaches from the sky to the center of the body.
 *
 * It is a {@link GlobeAnchor}, so children added to it stand at its center. Only the
 * picture changes: `heightAt`, `sampleHeight` and picking still see the terrain. A globe
 * hides at most {@link MAX_TERRAIN_MASKS}; those after are ignored.
 */
export class TerrainMask extends GlobeAnchor {
  readonly isTerrainMask = true;
  /** East-west size in meters, before `heading`. */
  width: number;
  /** North-south size in meters, before `heading`. */
  length: number;
  /** Degrees clockwise from north. */
  heading: number;

  constructor(
    latitude: number,
    longitude: number,
    { width, length, heading = 0 }: { width: number; length: number; heading?: number },
  ) {
    super(latitude, longitude, 0);
    if (!(width > 0) || !(length > 0) || !Number.isFinite(heading))
      throw new RangeError("Invalid terrain mask size.");
    this.name = "Terrain mask";
    this.width = width;
    this.length = length;
    this.heading = heading;
  }

  /** The rectangle's axes in the globe's frame, from its placed orientation. @internal */
  axes(across: Vector3, along: Vector3): void {
    const h = MathUtils.degToRad(this.heading);
    _east.set(1, 0, 0).applyQuaternion(this.quaternion);
    _north.set(0, 0, -1).applyQuaternion(this.quaternion);
    along.copy(_north).multiplyScalar(Math.cos(h)).addScaledVector(_east, Math.sin(h));
    across.copy(_east).multiplyScalar(Math.cos(h)).addScaledVector(_north, -Math.sin(h));
  }
}
