import { AmbientLight, DirectionalLight } from "three/webgpu";
import type { GlobeContext, GlobeEnvironment, GlobeFrame } from "../composition.ts";

export interface SunEnvironmentOptions {
  directIntensity?: number;
  ambientIntensity?: number;
}

/** Simple shared model lights for airless bodies. Terrain keeps its own reflectance. */
export function createSunEnvironment(options: SunEnvironmentOptions = {}): GlobeEnvironment {
  const direct = options.directIntensity ?? 3;
  const ambient = options.ambientIntensity ?? 0.08;
  if (![direct, ambient].every((value) => Number.isFinite(value) && value >= 0))
    throw new RangeError("Environment light intensities must be finite and nonnegative");
  let sun: DirectionalLight | undefined, fill: AmbientLight | undefined;
  function updateSun(context: GlobeContext) {
    sun?.position.copy(context.sun.direction).multiplyScalar(context.body.radiusMeters * 2);
  }
  return {
    id: "sun-environment",
    lightsModels: true,
    attach(context) {
      sun = new DirectionalLight(0xffffff, direct);
      fill = new AmbientLight(0xffffff, ambient);
      updateSun(context);
      context.scene.add(sun, sun.target, fill);
    },
    update({ context }: GlobeFrame) {
      updateSun(context);
    },
    dispose() {
      sun?.target.removeFromParent();
      sun?.removeFromParent();
      sun?.dispose();
      fill?.removeFromParent();
      fill?.dispose();
      sun = undefined;
      fill = undefined;
    },
  };
}
