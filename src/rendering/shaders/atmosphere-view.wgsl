// One entry of the view tables: the light gathered and the light let through along one ray
// from the camera, out to a fraction of its length through the air. Everything is in the
// frame where the camera is on +Z at radius r and the sun is in the XZ plane. Returns the
// gathered light in column 0 and transmittance in column 1.
fn atmosphereView(
  coord: vec3<u32>, size: vec3<f32>, r: f32, muSun: f32, bottom: f32, top: f32,
  lut: texture_2d<f32>, lutSampler: sampler,
  multiple: texture_2d<f32>, multipleSampler: sampler,
  rayleigh: vec4<f32>, mieScattering: vec4<f32>, mieExtinction: vec4<f32>,
  absorption: vec4<f32>, absorptionWidth: f32, intensity: f32,
  airglow: vec4<f32>, airglowWidth: f32
) -> mat3x3<f32> {
  let rows = size.y * 0.5;
  let ground = f32(coord.y) < rows;
  let row = select(f32(coord.y) - rows, f32(coord.y), ground);
  let angle = bandAngle(row / (rows - 1.0), viewBands(r, bottom, top), ground);
  let azimuth = 3.14159265 * f32(coord.x) / (size.x - 1.0);
  let fraction = f32(coord.z) / (size.z - 1.0);
  let dir = vec3<f32>(sin(angle) * cos(azimuth), sin(angle) * sin(azimuth), -cos(angle));
  let sun = vec3<f32>(sqrt(max(0.0, 1.0 - muSun * muSun)), 0.0, muSun);
  let o = vec3<f32>(0.0, 0.0, r);
  let b = dot(o, dir);
  let closest = r * sin(angle);
  let half = sqrt(max(0.0, (top - closest) * (top + closest)));
  let t0 = max(0.0, -b - half);
  var end = -b + half;
  if (ground) { end = -b - sqrt(max(0.0, (bottom - closest) * (bottom + closest))); }
  let t1 = t0 + max(0.0, end - t0) * fraction * fraction;

  let nu = dot(dir, sun);
  let rayleighPhase = 0.0596831 * (1.0 + nu * nu);
  let g = mieExtinction.w;
  let miePhase = 0.1193662 * (1.0 - g * g) / (2.0 + g * g) * (1.0 + nu * nu)
    / pow(1.0 + g * g - 2.0 * g * nu, 1.5);
  let steps = 16;
  let dt = (t1 - t0) / f32(steps);
  var depth = vec3<f32>(0.0);
  var light = vec3<f32>(0.0);
  var glow = vec3<f32>(0.0);
  for (var i = 0; i < steps; i++) {
    let p = o + dir * (t0 + (f32(i) + 0.5) * dt);
    let radius = length(p);
    let h = max(0.0, radius - bottom);
    let rhoR = exp(-h / rayleigh.w);
    let rhoM = exp(-h / mieScattering.w);
    let rhoO = max(0.0, 1.0 - abs(h - absorption.w) / (0.5 * absorptionWidth));
    let extinction = rayleigh.rgb * rhoR + mieExtinction.rgb * rhoM + absorption.rgb * rhoO;
    let mu = dot(p, sun) / radius;
    let toSun = sunTransmittance(lut, lutSampler, bottom, top, radius, mu);
    let bounced = textureSampleLevel(multiple, multipleSampler,
      vec2<f32>(mu * 0.5 + 0.5, h / (top - bottom)), 0.0).rgb;
    let scattering = rayleigh.rgb * rhoR * rayleighPhase + mieScattering.rgb * rhoM * miePhase;
    let spread = (rayleigh.rgb * rhoR + mieScattering.rgb * rhoM) * bounced;
    let view = exp(-(depth + extinction * dt * 0.5));
    light += view * (toSun * scattering + spread) * dt;
    let layer = (h - airglow.w) / airglowWidth;
    glow += view * airglow.rgb * exp(-layer * layer) * dt;
    depth += extinction * dt;
  }
  // π matches the terrain's sunlight scale: a white Lambert surface at noon reads 1.
  return mat3x3<f32>(light * intensity * 3.14159265 + glow, exp(-depth), vec3<f32>(0.0));
}
