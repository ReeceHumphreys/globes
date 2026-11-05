// From the sphere point radius * normal to the ellipsoid point with that normal. A small
// vector, so differences of it keep float32 precision. Matches ellipsoid.ts.
fn ellipsoidOffset(normal: vec3<f32>, radius: f32, e2: f32) -> vec3<f32> {
  let y2 = normal.y * normal.y;
  let s = sqrt(1.0 - e2 * y2);
  let k = e2 * y2 / (s * (1.0 + s));
  return vec3<f32>(k * normal.x, (k - e2 / s) * normal.y, k * normal.z) * radius;
}
