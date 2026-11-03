// The atmosphere between the camera and whatever was drawn behind each pixel, in view
// space (camera at the origin). Geometry pixels gain haze along the path to their
// depth; empty pixels gain the sky. One computation per pixel, against the real depth.
fn atmosphereSky(
  backdrop: vec3<f32>, viewPosition: vec3<f32>, direction: vec3<f32>, empty: f32,
  center: vec3<f32>, sun: vec3<f32>, bottom: f32, top: f32,
  lut: texture_2d<f32>, lutSampler: sampler,
  rayleigh: vec4<f32>, mieScattering: vec4<f32>, mieExtinction: vec4<f32>,
  absorption: vec4<f32>, absorptionWidth: f32, intensity: f32
) -> vec3<f32> {
  let dir = normalize(direction);
  // Ray against the top of the atmosphere, via the closest approach to the center:
  // this avoids subtracting two planet-sized squares when the camera is far away.
  let o = -center;
  let b = dot(o, dir);
  let closest = length(o - dir * b);
  if (closest >= top) { return backdrop; }
  let half = sqrt((top - closest) * (top + closest));
  let t0 = max(0.0, -b - half);
  var t1 = -b + half;
  if (t1 <= 0.0) { return backdrop; }
  if (empty < 0.5) {
    t1 = min(t1, length(viewPosition));
  } else if (closest < bottom) {
    // Nothing drawn, but the ray meets the planet: stop at its surface.
    let ground = -b - sqrt((bottom - closest) * (bottom + closest));
    if (ground > 0.0) { t1 = min(t1, ground); }
  }
  if (t1 <= t0) { return backdrop; }
  let nu = dot(dir, sun);
  let rayleighPhase = 0.0596831 * (1.0 + nu * nu);
  let g = mieExtinction.w;
  let miePhase = 0.1193662 * (1.0 - g * g) / (2.0 + g * g) * (1.0 + nu * nu)
    / pow(1.0 + g * g - 2.0 * g * nu, 1.5);
  let steps = 32;
  let dt = (t1 - t0) / f32(steps);
  var depth = vec3<f32>(0.0);
  var light = vec3<f32>(0.0);
  for (var i = 0; i < steps; i++) {
    let p = o + dir * (t0 + (f32(i) + 0.5) * dt);
    let r = length(p);
    let h = max(0.0, r - bottom);
    let rhoR = exp(-h / rayleigh.w);
    let rhoM = exp(-h / mieScattering.w);
    let rhoO = max(0.0, 1.0 - abs(h - absorption.w) / (0.5 * absorptionWidth));
    let extinction = rayleigh.rgb * rhoR + mieExtinction.rgb * rhoM + absorption.rgb * rhoO;
    let toSun = sunTransmittance(lut, lutSampler, bottom, top, r, dot(p, sun) / r);
    let scattering = rayleigh.rgb * rhoR * rayleighPhase + mieScattering.rgb * rhoM * miePhase;
    light += exp(-(depth + extinction * dt * 0.5)) * toSun * scattering * dt;
    depth += extinction * dt;
  }
  // π matches the terrain's sunlight scale: a white Lambert surface at noon reads 1.
  return backdrop * exp(-depth) + light * intensity * 3.14159265;
}
