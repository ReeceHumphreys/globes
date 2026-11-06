import * as THREE from "three/webgpu";

/** What to build {@link Clouds} from. */
export interface CloudsOptions {
  /** Equirectangular image URL, north-up, brightness as cloud cover. */
  map: string;
  /** Height of the cloud layer above the surface reference, in meters. */
  altitude?: number;
  /** Camera altitudes in meters: no clouds at the first, full strength at the second. */
  fadeAltitudes?: readonly [number, number];
}

/**
 * A thin layer of clouds seen from orbit, drawn by the globe's Atmosphere so haze falls
 * correctly in front of and behind it. It also shades the terrain below.
 *
 * Add it to a globe that has an Atmosphere: `earth.add(new Clouds({ map }))`. It fades
 * out as the camera descends, because a flat layer does not hold up from nearby and
 * would hide the ground. Set `visible = false` to turn it off.
 */
export class Clouds extends THREE.Object3D {
  /** @internal */
  readonly isClouds = true;
  override readonly type = "Clouds";
  /** Height of the layer above the surface reference, in meters. */
  readonly altitude: number;
  /** Camera altitudes in meters: no clouds at the first, full strength at the second. */
  readonly fadeAltitudes: readonly [number, number];
  /** The loaded image. @internal */
  map?: THREE.Texture;
  #disposed = false;

  constructor({ map, altitude = 10_000, fadeAltitudes = [100_000, 300_000] }: CloudsOptions) {
    super();
    if (!(altitude > 0)) throw new RangeError("Invalid cloud altitude");
    if (!(fadeAltitudes[0] < fadeAltitudes[1]) || !(fadeAltitudes[0] > altitude))
      throw new RangeError("Cloud fade must rise from above the clouds");
    this.name = "Clouds";
    this.altitude = altitude;
    this.fadeAltitudes = fadeAltitudes;
    new THREE.TextureLoader()
      .loadAsync(map)
      .then((texture) => {
        if (this.#disposed) return texture.dispose();
        texture.colorSpace = THREE.NoColorSpace;
        texture.flipY = false;
        texture.wrapS = THREE.RepeatWrapping;
        this.map = texture;
      })
      // The globe is complete without clouds.
      .catch((error: unknown) => console.warn("[Clouds]", error));
  }

  /** How solid the layer is from this camera altitude, 0 to 1. @internal */
  strengthAt(cameraAltitude: number): number {
    if (!this.visible || !this.map) return 0;
    return THREE.MathUtils.smoothstep(cameraAltitude, ...this.fadeAltitudes);
  }

  dispose(): void {
    this.#disposed = true;
    this.map?.dispose();
    this.map = undefined;
    this.removeFromParent();
  }
}
