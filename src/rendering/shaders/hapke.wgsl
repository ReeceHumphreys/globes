// Hapke reflectance with one global mean slope of 20°: single-term HG,
// shadow-hiding opposition, isotropic multiple scattering (H approximation),
// and the ISIS macroscopic-roughness term. Parameters are a visualization
// preset, not fitted regional science products. Coherent backscatter and
// porosity are omitted.
fn hapkeReflectance(normal: vec3<f32>, sun: vec3<f32>, view: vec3<f32>, parameters: vec4<f32>, reference: f32) -> f32 {
  let mu0Raw = dot(normalize(normal), normalize(sun));
  let muRaw = dot(normalize(normal), normalize(view));
  // A few degrees of fade, not a hard clip, so noisy normals do not sparkle
  // from lit to black along the terminator.
  let mu0 = max(mu0Raw, 0.001);
  let mu = max(muRaw, 0.001);
  let w = clamp(parameters.x, 0.001, 0.999);
  let g = clamp(parameters.y, -0.95, 0.95);
  let b0 = max(0.0, parameters.z);
  let h = max(0.001, parameters.w);
  let phase = clamp(dot(normalize(sun), normalize(view)), -1.0, 1.0);
  let result = hapkeRough(mu0, mu, phase, w, g, b0, h);
  // Same rough nadir (effective cosine is 1/Sr, shadowing rr2 is 1), so
  // overhead full sun stays at unit brightness.
  // Reference is precomputed when parameters are configured (rendering/hapke.ts).
  return max(0.0, result / max(reference, 0.000001))
    * smoothstep(-0.03, 0.08, mu0Raw)
    * smoothstep(0.0, 0.06, muRaw);
}

fn hapkeDisk(mu0: f32, mu: f32, phase: f32, w: f32, g: f32, b0: f32, h: f32) -> f32 {
  let mu0c = max(mu0, 0.0001);
  let muc = max(mu, 0.0001);
  let phaseDenominator = max(0.0001, 1.0 + 2.0 * g * phase + g * g);
  let particle = (1.0 - g * g) / pow(phaseDenominator, 1.5);
  let halfTangent = sqrt(max(0.0, (1.0 - phase) / max(0.000001, 1.0 + phase)));
  let opposition = b0 / (1.0 + halfTangent / h);
  let gamma = sqrt(1.0 - w);
  let h0 = (1.0 + 2.0 * mu0c) / (1.0 + 2.0 * mu0c * gamma);
  let he = (1.0 + 2.0 * muc) / (1.0 + 2.0 * muc * gamma);
  return (w * 0.25) * (mu0c / max(0.000001, mu0c + muc)) * ((1.0 + opposition) * particle + h0 * he - 1.0);
}

fn hapkeRough(mu0: f32, mu: f32, phase: f32, w: f32, g: f32, b0: f32, h: f32) -> f32 {
  // shortcut: one global 20° slope, not a fitted map. Upgrade when a region still shows a photometric ramp this angle cannot remove.
  let theta = radians(20.0);
  let pi = acos(-1.0);
  let cost = cos(theta);
  let sint = sin(theta);
  let cott = cost / max(sint, 1e-10);
  let cot2t = cott * cott;
  let tant = sint / max(cost, 1e-10);
  let sr = sqrt(1.0 + pi * tant * tant);
  let osr = 1.0 / sr;
  let sinI = sqrt(max(0.0, 1.0 - mu0 * mu0));
  let sinE = sqrt(max(0.0, 1.0 - mu * mu));
  let cotI = mu0 / max(sinI, 1e-10);
  let cotE = mu / max(sinE, 1e-10);
  // A near-zero angle makes cot huge. Clamp so exp underflows to 0 instead of overflowing f32.
  let ecotI = exp(clamp(-cot2t * cotI * cotI / pi, -40.0, 23.0));
  let ecot2I = exp(clamp(-2.0 * cott * cotI / pi, -40.0, 23.0));
  let ecotE = exp(clamp(-cot2t * cotE * cotE / pi, -40.0, 23.0));
  let ecot2E = exp(clamp(-2.0 * cott * cotE / pi, -40.0, 23.0));
  let u0p0 = osr * (mu0 + sinI * tant * ecotI / max(2.0 - ecot2I, 1e-6));
  let up0 = osr * (mu + sinE * tant * ecotE / max(2.0 - ecot2E, 1e-6));
  let sinEI = sinE * sinI;
  var caz = 1.0;
  var az = 0.0;
  if (sinEI > 1e-8) {
    caz = clamp((phase - mu * mu0) / sinEI, -1.0, 1.0);
    az = acos(caz);
  }
  let az2 = az * 0.5;
  var faz = 0.0;
  // az = 180° makes tan(az/2) singular. ISIS sets the shadowing factor to 0 there.
  if (caz > -0.999999) {
    faz = exp(clamp(-2.0 * tan(az2), -40.0, 23.0));
  }
  let sin2a2 = sin(az2) * sin(az2);
  let api = az / pi;
  var q = 1.0;
  var u0p = u0p0;
  var up = up0;
  // Larger geometric cosine is the smaller angle, so this is incidence <= emission.
  if (mu0 >= mu) {
    q = osr * mu0 / max(u0p0, 1e-6);
    let ecei = max(2.0 - ecot2E - api * ecot2I, 1e-6);
    let s2ei = sin2a2 * ecotI;
    u0p = osr * (mu0 + sinI * tant * (caz * ecotE + s2ei) / ecei);
    up = osr * (mu + sinE * tant * (ecotE - s2ei) / ecei);
  } else {
    q = osr * mu / max(up0, 1e-6);
    let ecee = max(2.0 - ecot2I - api * ecot2E, 1e-6);
    let s2ee = sin2a2 * ecotE;
    u0p = osr * (mu0 + sinI * tant * (ecotI - s2ee) / ecee);
    up = osr * (mu + sinE * tant * (caz * ecotI + s2ee) / ecee);
  }
  let rr1 = hapkeDisk(u0p, up, phase, w, g, b0, h);
  let shadow = max(1.0 - faz + faz * q, 1e-6);
  let rr2 = up * mu0 / max(up0 * u0p0 * sr * shadow, 1e-6);
  return max(0.0, rr1 * rr2);
}
