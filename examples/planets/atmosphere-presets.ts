import {
  AtmosphereParameters,
  DensityProfile,
  DensityProfileLayer,
} from "@takram/three-atmosphere/webgpu";

export type AtmosphereBody = "earth" | "mars";
export const MARS_DUST_OPTICAL_DEPTH = 0.2;
export const MARS_SCALE_HEIGHT_METERS = 11000;
export interface AtmospherePresetOptions {
  marsDustOpticalDepth?: number;
}

/** Standard Earth profile or an explicitly approximate, uniform Mars dust profile. */
export function atmosphereParameters(
  body: AtmosphereBody,
  radiusMeters: number,
  options: AtmospherePresetOptions = {},
): AtmosphereParameters {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0)
    throw new RangeError("Invalid atmosphere radius");
  const parameters = new AtmosphereParameters();
  const thickness = body === "mars" ? 80000 : parameters.topRadius - parameters.bottomRadius;
  parameters.bottomRadius = radiusMeters;
  parameters.topRadius = radiusMeters + thickness;
  if (body === "mars") {
    const dust = options.marsDustOpticalDepth ?? MARS_DUST_OPTICAL_DEPTH;
    if (!Number.isFinite(dust) || dust < 0 || dust > 3)
      throw new RangeError("Mars dust optical depth must be between 0 and 3");
    // Keep all three aerosol bands; Earth's packed single-Mie reconstruction
    // is a poor fit for this absorbing, spectrally varying dust prescription.
    parameters.combinedScatteringTextures = false;
    parameters.solarIrradiance.multiplyScalar(586.2 / 1361.0);
    parameters.sunAngularRadius = ((0.35 / 2) * Math.PI) / 180;
    parameters.rayleighDensity = new DensityProfile([
      new DensityProfileLayer(),
      new DensityProfileLayer(0, 1, -1 / MARS_SCALE_HEIGHT_METERS),
    ]);
    // Rough CO2 molecular scattering proxy, not a retrieved spectral cross-section.
    parameters.rayleighScattering.multiplyScalar(0.02);
    parameters.mieDensity = parameters.rayleighDensity.clone();
    // Normalize the truncated exponential so the green-channel vertical optical
    // depth is the chosen value. Bands are the dependency's 680/550/440 nm.
    const column = MARS_SCALE_HEIGHT_METERS * -Math.expm1(-thickness / MARS_SCALE_HEIGHT_METERS);
    parameters.mieExtinction.set(dust * 0.9, dust, dust * 1.1).divideScalar(column);
    parameters.mieScattering.copy(parameters.mieExtinction).multiply({ x: 0.94, y: 0.9, z: 0.8 });
    parameters.miePhaseFunctionG = 0.7;
    // Do not carry Earth's ozone absorber into the Mars preset.
    parameters.absorptionExtinction.setScalar(0);
    parameters.absorptionDensity = new DensityProfile([
      new DensityProfileLayer(),
      new DensityProfileLayer(),
    ]);
    parameters.groundAlbedo.setScalar(0.15);
  }
  return parameters.update();
}
