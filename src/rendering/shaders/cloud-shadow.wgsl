// Sunlight left after the clouds between this ground point and the sun.
fn cloudShadow(
  map: texture_2d<f32>, mapSampler: sampler, radial: vec3<f32>, sun: vec3<f32>,
  radius: f32, height: f32, strength: f32
) -> f32 {
  let up = normalize(radial);
  let toSun = normalize(sun);
  let mu = dot(up, toSun);
  if (strength <= 0.0 || mu <= 0.0) { return 1.0; }
  // Light scattered through a cloud deck blurs its shadow, hence the coarser mip level.
  let above = up * radius + toSun * (height / max(mu, 0.1));
  return 1.0 - 0.7 * strength * cloudCover(map, mapSampler, above, 2.0);
}
