// Both grids draw between 80 and 81 degrees. Each pixel there keeps exactly one of them,
// more often the cap toward the pole, so the terrain stays opaque and depth-tested.
fn rootJoin(direction: vec3<f32>, root: f32, pixel: vec2<f32>) -> f32 {
  let cap = smoothstep(SIN_JOIN_START, SIN_JOIN_END, abs(normalize(direction).y));
  // Interleaved gradient noise, after Jimenez (2014).
  let noise = fract(52.9829189 * fract(dot(floor(pixel), vec2<f32>(0.06711056, 0.00583715))));
  // The grids disagree slightly about where a pixel is. Overlap, so none is dropped by both.
  if (root >= CAP_ROOT_START) { return select(0.0, 1.0, noise < cap + 0.02); }
  return select(0.0, 1.0, noise >= cap - 0.02);
}
