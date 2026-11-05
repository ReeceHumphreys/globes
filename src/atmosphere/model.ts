/**
 * A planetary atmosphere as data: scattering coefficients per RGB channel, and the
 * two lookup tables the shaders need, built once on the CPU.
 *
 * - Transmittance: the fraction of light that survives from a point at radius r,
 *   looking in a direction with cosine mu from the zenith, to the top of the
 *   atmosphere. Parameterized as in Bruneton (2017), which keeps the horizon sharp.
 * - Ground sky light: irradiance on a level surface from the sky alone, by the
 *   cosine of the sun's zenith angle, for a sun of irradiance 1 (single scattering).
 *
 * - Multiple scattering: light that has scattered more than once, by sun cosine and
 *   height, after Hillaire (2020). It brightens the limb and the twilight sky.
 *
 * Lengths are meters; coefficients are per meter.
 */

export type RGB = readonly [number, number, number];

export interface AtmospherePreset {
  /** Thickness of the atmosphere above the surface. */
  height: number;
  /** Molecular scattering (no absorption) with an exponential density. */
  rayleigh: { scattering: RGB; scaleHeight: number };
  /** Aerosols: scattering, total extinction, exponential density and phase asymmetry g. */
  mie: { scattering: RGB; extinction: RGB; scaleHeight: number; g: number };
  /** An absorbing layer, such as ozone: tent-shaped density centered at `center`. */
  absorption?: { extinction: RGB; center: number; width: number };
  /** Sunlight relative to the terrain's own: 1 matches the globe's sun. */
  intensity: number;
  /** Faint light on the night side, such as moonlight, in the terrain's light units. */
  nightLight?: RGB;
  /** A thin layer of air that glows by itself: radiance per meter of path. */
  airglow?: { emission: RGB; altitude: number; width: number };
}

/** Clear-sky Earth (Hillaire 2020 / Bruneton 2017 coefficients, 680/550/440 nm). */
export const EARTH_AIR: AtmospherePreset = {
  height: 100_000,
  rayleigh: { scattering: [5.802e-6, 13.558e-6, 33.1e-6], scaleHeight: 8_000 },
  mie: {
    scattering: [3.996e-6, 3.996e-6, 3.996e-6],
    extinction: [4.4e-6, 4.4e-6, 4.4e-6],
    scaleHeight: 1_200,
    g: 0.8,
  },
  absorption: { extinction: [0.65e-6, 1.881e-6, 0.085e-6], center: 25_000, width: 30_000 },
  intensity: 1,
  nightLight: [0.0035, 0.0045, 0.008],
  // The 557.7 nm oxygen line, far brighter here than in life so that the limb shows it.
  airglow: { emission: [0.2e-8, 0.7e-8, 0.3e-8], altitude: 92_000, width: 5_000 },
};

/**
 * An approximate dusty Mars sky: a thin CO₂ proxy plus uniform dust with the given
 * vertical optical depth (about 0.2–0.5 on a clear day). Not a retrieved profile.
 */
export function marsAir(dustOpticalDepth = 0.2): AtmospherePreset {
  if (!Number.isFinite(dustOpticalDepth) || dustOpticalDepth < 0 || dustOpticalDepth > 3)
    throw new RangeError("Mars dust optical depth must be between 0 and 3");
  const height = 80_000,
    scaleHeight = 11_000;
  // Normalize the truncated exponential so the green vertical optical depth is the chosen value.
  const column = scaleHeight * -Math.expm1(-height / scaleHeight);
  const extinction = [0.9, 1, 1.1].map((k) => (k * dustOpticalDepth) / column) as unknown as RGB;
  return {
    height,
    rayleigh: {
      scattering: EARTH_AIR.rayleigh.scattering.map((k) => k * 0.02) as unknown as RGB,
      scaleHeight,
    },
    mie: {
      extinction,
      // Dust absorbs more blue than red: the butterscotch day, blue sunset.
      scattering: [extinction[0] * 0.94, extinction[1] * 0.9, extinction[2] * 0.8],
      scaleHeight,
      g: 0.7,
    },
    // Mars is about 1.52 AU out: 586 W/m² against Earth's 1361.
    intensity: 586.2 / 1361,
  };
}
export const MARS_AIR = marsAir();

export const TRANSMITTANCE_WIDTH = 256;
export const TRANSMITTANCE_HEIGHT = 64;
export const SKY_LIGHT_WIDTH = 64;
export const MULTIPLE_SCATTERING_SIZE = 32;

export interface AtmosphereModel {
  readonly preset: AtmospherePreset;
  /** Planet radius. */
  readonly bottom: number;
  /** Radius of the top of the atmosphere. */
  readonly top: number;
  /** RGBA rows, TRANSMITTANCE_WIDTH × TRANSMITTANCE_HEIGHT. */
  readonly transmittance: Float32Array;
  /** RGBA, SKY_LIGHT_WIDTH entries from sun zenith cosine −1 to 1. */
  readonly skyLight: Float32Array;
  /** RGBA, square: columns are sun cosine −1 to 1, rows are height, bottom to top. */
  readonly multipleScattering: Float32Array;
  /** Transmittance to the top of the atmosphere; zero when the ray meets the ground. */
  transmittanceToSun(r: number, mu: number, out: Float64Array): Float64Array;
}

const PI = Math.PI;

export function buildAtmosphere(preset: AtmospherePreset, radius: number): AtmosphereModel {
  if (!(radius > 0) || !(preset.height > 0)) throw new RangeError("Invalid atmosphere size");
  const bottom = radius,
    top = radius + preset.height;
  const H = Math.sqrt(top * top - bottom * bottom);
  const extinction = new Float64Array(3);
  const { rayleigh, mie, absorption } = preset;

  function densities(h: number): [number, number, number] {
    const ozone = absorption
      ? Math.max(0, 1 - Math.abs(h - absorption.center) / (absorption.width / 2))
      : 0;
    return [Math.exp(-h / rayleigh.scaleHeight), Math.exp(-h / mie.scaleHeight), ozone];
  }
  function extinctionAt(h: number, out: Float64Array) {
    const [r, m, o] = densities(Math.max(0, h));
    for (let c = 0; c < 3; c++)
      out[c] =
        rayleigh.scattering[c] * r + mie.extinction[c] * m + (absorption?.extinction[c] ?? 0) * o;
    return out;
  }
  const distanceToTop = (r: number, mu: number) =>
    Math.max(0, -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + top * top)));
  const hitsGround = (r: number, mu: number) =>
    mu < 0 && r * r * (mu * mu - 1) + bottom * bottom >= 0;

  // --- Transmittance table -------------------------------------------------------------
  const transmittance = new Float32Array(TRANSMITTANCE_WIDTH * TRANSMITTANCE_HEIGHT * 4);
  const tau = new Float64Array(3);
  for (let j = 0; j < TRANSMITTANCE_HEIGHT; j++)
    for (let i = 0; i < TRANSMITTANCE_WIDTH; i++) {
      const rho = H * (j / (TRANSMITTANCE_HEIGHT - 1));
      const r = Math.sqrt(rho * rho + bottom * bottom);
      const dMin = top - r,
        dMax = rho + H;
      const d = dMin + (i / (TRANSMITTANCE_WIDTH - 1)) * (dMax - dMin);
      const mu = d === 0 ? 1 : Math.min(1, Math.max(-1, (H * H - rho * rho - d * d) / (2 * r * d)));
      opticalDepth(r, mu, d, tau);
      const k = (j * TRANSMITTANCE_WIDTH + i) * 4;
      transmittance[k] = Math.exp(-tau[0]);
      transmittance[k + 1] = Math.exp(-tau[1]);
      transmittance[k + 2] = Math.exp(-tau[2]);
      transmittance[k + 3] = 1;
    }

  function opticalDepth(r: number, mu: number, d: number, out: Float64Array) {
    const steps = 64,
      dt = d / steps;
    out.fill(0);
    for (let s = 0; s <= steps; s++) {
      const t = s * dt;
      const h = Math.sqrt(t * t + 2 * r * mu * t + r * r) - bottom;
      const weight = s === 0 || s === steps ? 0.5 : 1;
      extinctionAt(h, extinction);
      for (let c = 0; c < 3; c++) out[c] += extinction[c] * dt * weight;
    }
  }

  /** Same mapping as transmittanceUV in atmosphere.wgsl. */
  function transmittanceToSun(r: number, mu: number, out: Float64Array): Float64Array {
    if (hitsGround(r, mu)) return out.fill(0);
    const rho = Math.sqrt(Math.max(0, r * r - bottom * bottom));
    const d = distanceToTop(r, mu),
      dMin = top - r,
      dMax = rho + H;
    const x = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0;
    const y = rho / H;
    // Bilinear, texel centers at i / (W - 1).
    const fx = Math.min(Math.max(x, 0), 1) * (TRANSMITTANCE_WIDTH - 1),
      fy = Math.min(Math.max(y, 0), 1) * (TRANSMITTANCE_HEIGHT - 1);
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy),
      x1 = Math.min(x0 + 1, TRANSMITTANCE_WIDTH - 1),
      y1 = Math.min(y0 + 1, TRANSMITTANCE_HEIGHT - 1),
      ax = fx - x0,
      ay = fy - y0;
    for (let c = 0; c < 3; c++) {
      const at = (i: number, j: number) => transmittance[(j * TRANSMITTANCE_WIDTH + i) * 4 + c];
      out[c] =
        (at(x0, y0) * (1 - ax) + at(x1, y0) * ax) * (1 - ay) +
        (at(x0, y1) * (1 - ax) + at(x1, y1) * ax) * ay;
    }
    return out;
  }

  // --- Ground sky light ------------------------------------------------------------------
  // Integrate single-scattered sky radiance over the upper hemisphere of a level point.
  const skyLight = new Float32Array(SKY_LIGHT_WIDTH * 4);
  const zeniths = 16,
    azimuths = 32,
    steps = 24;
  const sunT = new Float64Array(3);
  const r0 = bottom + 1;
  for (let k = 0; k < SKY_LIGHT_WIDTH; k++) {
    const muSun = -1 + (2 * k) / (SKY_LIGHT_WIDTH - 1);
    const sun = [Math.sqrt(1 - muSun * muSun), muSun, 0];
    const irradiance = [0, 0, 0];
    for (let a = 0; a < zeniths; a++) {
      const theta = ((a + 0.5) / zeniths) * (PI / 2);
      const dTheta = PI / 2 / zeniths;
      for (let b = 0; b < azimuths; b++) {
        const phi = ((b + 0.5) / azimuths) * 2 * PI;
        const dir = [
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi),
        ];
        const nu = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
        const pr = rayleighPhase(nu),
          pm = miePhase(nu, mie.g);
        const d = distanceToTop(r0, dir[1]),
          dt = d / steps;
        const radiance = [0, 0, 0],
          depth = [0, 0, 0];
        for (let s = 0; s < steps; s++) {
          const t = (s + 0.5) * dt;
          const p = [dir[0] * t, r0 + dir[1] * t, dir[2] * t];
          const r = Math.hypot(p[0], p[1], p[2]);
          const [rhoR, rhoM] = densities(r - bottom);
          extinctionAt(r - bottom, extinction);
          transmittanceToSun(r, (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / r, sunT);
          for (let c = 0; c < 3; c++) {
            const view = Math.exp(-(depth[c] + extinction[c] * dt * 0.5));
            const scatter = rayleigh.scattering[c] * rhoR * pr + mie.scattering[c] * rhoM * pm;
            radiance[c] += view * sunT[c] * scatter * dt;
            depth[c] += extinction[c] * dt;
          }
        }
        const solidAngle = Math.sin(theta) * dTheta * ((2 * PI) / azimuths);
        for (let c = 0; c < 3; c++) irradiance[c] += radiance[c] * Math.cos(theta) * solidAngle;
      }
    }
    skyLight.set([irradiance[0], irradiance[1], irradiance[2], 1], k * 4);
  }

  // --- Multiple scattering ---------------------------------------------------------------
  // Hillaire (2020): light arriving from all directions after one more bounce, summed as a
  // geometric series. Scattering is taken as isotropic past the first bounce.
  const multipleScattering = new Float32Array(MULTIPLE_SCATTERING_SIZE ** 2 * 4);
  const directions = 32,
    marchSteps = 16,
    groundAlbedo = 0.1;
  const onSphere: [number, number, number][] = [];
  for (let i = 0; i < directions; i++) {
    // A Fibonacci sphere: even coverage from few rays.
    const y = 1 - (2 * (i + 0.5)) / directions,
      ring = Math.sqrt(1 - y * y),
      angle = i * PI * (3 - Math.sqrt(5));
    onSphere.push([ring * Math.cos(angle), y, ring * Math.sin(angle)]);
  }
  const weight = (4 * PI) / directions / (4 * PI);
  for (let j = 0; j < MULTIPLE_SCATTERING_SIZE; j++)
    for (let i = 0; i < MULTIPLE_SCATTERING_SIZE; i++) {
      const muSun = -1 + (2 * i) / (MULTIPLE_SCATTERING_SIZE - 1);
      const r0 = bottom + 1 + ((top - bottom - 2) * j) / (MULTIPLE_SCATTERING_SIZE - 1);
      const sun = [Math.sqrt(1 - muSun * muSun), muSun, 0];
      const once = [0, 0, 0],
        transfer = [0, 0, 0];
      for (const dir of onSphere) {
        const ground = hitsGround(r0, dir[1]);
        const d = ground
          ? -r0 * dir[1] - Math.sqrt(Math.max(0, r0 * r0 * (dir[1] ** 2 - 1) + bottom ** 2))
          : distanceToTop(r0, dir[1]);
        const dt = d / marchSteps;
        const depth = [0, 0, 0];
        for (let s = 0; s < marchSteps; s++) {
          const t = (s + 0.5) * dt;
          const p = [dir[0] * t, r0 + dir[1] * t, dir[2] * t];
          const r = Math.hypot(p[0], p[1], p[2]);
          const [rhoR, rhoM] = densities(r - bottom);
          extinctionAt(r - bottom, extinction);
          transmittanceToSun(r, (p[0] * sun[0] + p[1] * sun[1]) / r, sunT);
          for (let c = 0; c < 3; c++) {
            const view = Math.exp(-(depth[c] + extinction[c] * dt * 0.5));
            const scatter = rayleigh.scattering[c] * rhoR + mie.scattering[c] * rhoM;
            once[c] += (view * sunT[c] * scatter * dt * weight) / (4 * PI);
            transfer[c] += view * scatter * dt * weight;
            depth[c] += extinction[c] * dt;
          }
        }
        if (ground) {
          // Light off the ground, a dark Lambert surface: mostly ocean and forest.
          const p = [dir[0] * d, r0 + dir[1] * d, dir[2] * d];
          const r = Math.hypot(p[0], p[1], p[2]);
          const mu = (p[0] * sun[0] + p[1] * sun[1]) / r;
          transmittanceToSun(r, mu, sunT);
          for (let c = 0; c < 3; c++)
            once[c] +=
              (Math.exp(-depth[c]) * sunT[c] * Math.max(mu, 0) * groundAlbedo * weight) / PI;
        }
      }
      const k = (j * MULTIPLE_SCATTERING_SIZE + i) * 4;
      for (let c = 0; c < 3; c++)
        multipleScattering[k + c] = once[c] / (1 - Math.min(transfer[c], 0.99));
      multipleScattering[k + 3] = 1;
    }

  return { preset, bottom, top, transmittance, skyLight, multipleScattering, transmittanceToSun };
}

export function rayleighPhase(nu: number): number {
  return (3 / (16 * PI)) * (1 + nu * nu);
}

/** Cornette–Shanks, as in Bruneton (2017). */
export function miePhase(nu: number, g: number): number {
  const k = (3 / (8 * PI)) * ((1 - g * g) / (2 + g * g));
  return (k * (1 + nu * nu)) / Math.pow(1 + g * g - 2 * g * nu, 1.5);
}
