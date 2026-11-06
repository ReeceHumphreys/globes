// Where a sun zenith cosine falls in the sky-light table, on its texel centers.
fn skyLightU(mu: f32, width: f32) -> f32 {
  return ((mu + 1.0) * 0.5 * (width - 1.0) + 0.5) / width;
}
