// A jump from u≈1 to u≈0 is a wrap, not a huge texture footprint. Correct
// derivatives before mip selection so the antimeridian does not become a blur.
fn longitudeUVGradient(gradient: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(gradient.x - round(gradient.x), gradient.y);
}
