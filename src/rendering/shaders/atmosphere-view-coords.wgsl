// The view tables hold every ray from the camera, in two bands that never blend: rays that
// reach the ground, and rays that do not. Angles are from straight down, so the limb, a
// sliver of the view from orbit, gets as many rows as the whole disc. Bands are
// (angle of the ground's edge, angle of the atmosphere's edge).
fn viewBands(r: f32, bottom: f32, top: f32) -> vec2<f32> {
  let ground = asin(min(1.0, bottom / r));
  return vec2<f32>(ground, select(3.14159265, asin(top / r), r > top));
}

// Position within a band, 0 to 1, with rows packed toward the ground's edge.
fn bandPosition(angle: f32, bands: vec2<f32>, ground: bool) -> f32 {
  if (ground) { return 1.0 - sqrt(clamp(1.0 - angle / bands.x, 0.0, 1.0)); }
  return sqrt(clamp((angle - bands.x) / max(bands.y - bands.x, 1e-6), 0.0, 1.0));
}

fn bandAngle(position: f32, bands: vec2<f32>, ground: bool) -> f32 {
  if (ground) { return bands.x * position * (2.0 - position); }
  return bands.x + (bands.y - bands.x) * position * position;
}
