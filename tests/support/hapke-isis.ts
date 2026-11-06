// ISIS Hapke roughness (PhotoModelAlgorithm) at the visualization preset.
// The curve hapke.wgsl transcribes: tests/gpu runs the shader against it.
export const W = 0.23;
export const G = -0.3;
export const B0 = 1;
export const H = 0.05;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function disk(mu0: number, mu: number, phase: number): number {
  const mu0c = Math.max(mu0, 0.0001);
  const muc = Math.max(mu, 0.0001);
  const phaseDenominator = Math.max(0.0001, 1 + 2 * G * phase + G * G);
  const particle = (1 - G * G) / phaseDenominator ** 1.5;
  const halfTangent = Math.sqrt(Math.max(0, (1 - phase) / Math.max(0.000001, 1 + phase)));
  const opposition = B0 / (1 + halfTangent / H);
  const gamma = Math.sqrt(1 - W);
  const h0 = (1 + 2 * mu0c) / (1 + 2 * mu0c * gamma);
  const he = (1 + 2 * muc) / (1 + 2 * muc * gamma);
  return (
    W * 0.25 * (mu0c / Math.max(0.000001, mu0c + muc)) * ((1 + opposition) * particle + h0 * he - 1)
  );
}

export function rough(mu0: number, mu: number, phase: number, thetaDeg: number): number {
  const theta = (thetaDeg * Math.PI) / 180;
  const cost = Math.cos(theta);
  const sint = Math.sin(theta);
  const cott = cost / Math.max(sint, 1e-10);
  const cot2t = cott * cott;
  const tant = sint / Math.max(cost, 1e-10);
  const sr = Math.sqrt(1 + Math.PI * tant * tant);
  const osr = 1 / sr;
  const sinI = Math.sqrt(Math.max(0, 1 - mu0 * mu0));
  const sinE = Math.sqrt(Math.max(0, 1 - mu * mu));
  const cotI = mu0 / Math.max(sinI, 1e-10);
  const cotE = mu / Math.max(sinE, 1e-10);
  const eexp = (arg: number) => Math.exp(Math.min(23, Math.max(-40, arg)));
  const ecotI = eexp((-cot2t * cotI * cotI) / Math.PI);
  const ecot2I = eexp((-2 * cott * cotI) / Math.PI);
  const ecotE = eexp((-cot2t * cotE * cotE) / Math.PI);
  const ecot2E = eexp((-2 * cott * cotE) / Math.PI);
  const u0p0 = osr * (mu0 + (sinI * tant * ecotI) / Math.max(2 - ecot2I, 1e-6));
  const up0 = osr * (mu + (sinE * tant * ecotE) / Math.max(2 - ecot2E, 1e-6));
  const sinEI = sinE * sinI;
  let caz = 1;
  let az = 0;
  if (sinEI > 1e-8) {
    caz = Math.min(1, Math.max(-1, (phase - mu * mu0) / sinEI));
    az = Math.acos(caz);
  }
  const az2 = az * 0.5;
  let faz = 0;
  if (caz > -0.999999) faz = eexp(-2 * Math.tan(az2));
  const sin2a2 = Math.sin(az2) ** 2;
  const api = az / Math.PI;
  let q = 1;
  let u0p = u0p0;
  let up = up0;
  if (mu0 >= mu) {
    q = (osr * mu0) / Math.max(u0p0, 1e-6);
    const ecei = Math.max(2 - ecot2E - api * ecot2I, 1e-6);
    const s2ei = sin2a2 * ecotI;
    u0p = osr * (mu0 + (sinI * tant * (caz * ecotE + s2ei)) / ecei);
    up = osr * (mu + (sinE * tant * (ecotE - s2ei)) / ecei);
  } else {
    q = (osr * mu) / Math.max(up0, 1e-6);
    const ecee = Math.max(2 - ecot2I - api * ecot2E, 1e-6);
    const s2ee = sin2a2 * ecotE;
    u0p = osr * (mu0 + (sinI * tant * (ecotI - s2ee)) / ecee);
    up = osr * (mu + (sinE * tant * (caz * ecotI + s2ee)) / ecee);
  }
  const rr1 = disk(u0p, up, phase);
  const shadow = Math.max(1 - faz + faz * q, 1e-6);
  const rr2 = (up * mu0) / Math.max(up0 * u0p0 * sr * shadow, 1e-6);
  return Math.max(0, rr1 * rr2);
}

export function reflectance(
  mu0Raw: number,
  muRaw: number,
  phase: number,
  thetaDeg: number,
): number {
  const mu0 = Math.max(mu0Raw, 0.001);
  const mu = Math.max(muRaw, 0.001);
  const value = rough(mu0, mu, phase, thetaDeg);
  const reference = rough(1, 1, 1, thetaDeg);
  const fade = smoothstep(-0.03, 0.08, mu0Raw) * smoothstep(0, 0.06, muRaw);
  return Math.max(0, value / Math.max(reference, 0.000001)) * fade;
}
