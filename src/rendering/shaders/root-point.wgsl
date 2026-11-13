// The root owning a direction, then its u and v. Matches rootPoint in tiles/roots.ts.
fn rootPoint(direction: vec3<f32>) -> vec3<f32> {
  let d = normalize(direction);
  if (abs(d.y) > SIN_JOIN_MIDDLE) {
    if (d.y > 0.0) {
      let p = vec2<f32>(-d.z, -d.x) / (1.0 + d.y);
      return vec3<f32>(2.0, (p / CAP_HALF + 1.0) * 0.5);
    }
    let p = vec2<f32>(-d.z, d.x) / (1.0 - d.y);
    return vec3<f32>(3.0, (p / CAP_HALF + 1.0) * 0.5);
  }
  let longitude = atan2(-d.z, d.x);
  let latitude = atan2(d.y, length(d.xz));
  var root = 1.0;
  if (longitude < 0.0) { root = 0.0; }
  return vec3<f32>(root, longitude / 3.14159265 + 1.0 - root, latitude / 3.14159265 + 0.5);
}
