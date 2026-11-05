// The look of the cloud layer at one point: light leaving it in rgb, opacity in a.
// `slant` is the cosine between the view and the layer's vertical.
fn cloudLight(
  map: texture_2d<f32>, mapSampler: sampler, normal: vec3<f32>, radius: f32, lod: f32,
  pixelMeters: f32, slant: f32, strength: f32, mu: f32, sun: vec3<f32>,
  sunlight: vec3<f32>, ambient: vec3<f32>
) -> vec4<f32> {
  var density = cloudCover(map, mapSampler, normal, lod);
  if (density <= 0.0) { return vec4<f32>(0.0); }
  // The map runs out of detail from low orbit: ragged edges past its 5 km texels.
  let fine = vec2<f32>(cover(30000.0, pixelMeters), cover(9000.0, pixelMeters));
  let noise = (valueNoise(normal * (radius / 30000.0)) - 0.5) * fine.x
    + (valueNoise(normal * (radius / 9000.0)) - 0.5) * fine.y * 0.6;
  density = clamp(density + noise * 1.6 * density * (1.0 - density), 0.0, 1.0);
  // Cloud that stands higher toward the sun shades this point: a thin layer's only relief.
  var shade = 1.0;
  if (mu > 0.0) {
    let toward = normalize(sun - normal * mu);
    let reach = 12000.0 / (radius * max(mu, 0.15));
    let sunward = cloudCover(map, mapSampler, normalize(normal + toward * reach), lod + 1.0);
    shade = clamp(1.0 - 0.9 * (sunward - density), 0.45, 1.15);
  }
  // Thin cloud reflects less and shows more of what is under it.
  let albedo = mix(0.55, 1.0, density);
  let cover01 = density * strength;
  // A layer seen edge-on is a longer path through the same cloud.
  let alpha = 1.0 - pow(1.0 - cover01, 1.0 / slant);
  return vec4<f32>(albedo * (sunlight * max(mu, 0.0) * shade + ambient), alpha);
}
