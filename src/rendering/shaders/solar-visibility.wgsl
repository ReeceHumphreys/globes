// Analytic occlusion by a sphere inside all supplied terrain. The lower bound
// permits elevated peaks to see over the horizon without lighting deep night.
// Use a difference of radii to retain precision near the surface.
fn solarVisibility(direction: vec3<f32>, sun: vec3<f32>, radius: f32, height: f32, minimumHeight: f32) -> f32 {
  let inner = max(1.0, radius + minimumHeight);
  let r = max(inner, radius + height);
  let horizonDip = sqrt(max(0.0, (height - minimumHeight) * (r + inner))) / r;
  let incidence = dot(normalize(direction), normalize(sun));
  // Approximate 0.533 degree solar disk, expressed as a sine of its radius.
  let solarRadius = 0.004651;
  return smoothstep(-horizonDip - solarRadius, -horizonDip + solarRadius, incidence);
}

fn shadowedShade(reflectance: f32, normalSun: f32, visibility: f32) -> f32 {
  // The artistic daylight floor must obey occlusion just like direct light.
  let daylightFloor = smoothstep(0.0, 0.25, normalSun) * 0.24;
  return max(reflectance, daylightFloor) * clamp(visibility, 0.0, 1.0);
}
