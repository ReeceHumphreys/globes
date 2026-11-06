// Meters from a height texel's two bytes, read as 0..1. Matches heightMeters in tiles.ts.
fn decodeHeight(packed: vec2<f32>) -> f32 {
  return dot(packed, vec2<f32>(255.0, 65280.0)) * 0.5 - 10000.0;
}
