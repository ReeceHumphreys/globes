fn normalFromGradient(direction: vec3<f32>, slope: vec2<f32>, step: vec2<f32>, root: f32, rootScale: f32, radius: f32) -> vec3<f32> {
  let d = normalize(direction);
  // Differentiate the unit sphere analytically: avoid subtracting positions
  // around 1.7 million meters to recover a meter-scale surface normal.
  let tangents = rootTangents(root, d);
  let edgeU = tangents[0] * (2.0 * radius * rootScale * step.x) + d * slope.x;
  let edgeV = tangents[1] * (2.0 * radius * rootScale * step.y) + d * slope.y;
  return normalize(cross(edgeU, edgeV));
}
