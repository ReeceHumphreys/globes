// See tiles/roots.ts. Root 0 and 1 are latitude and longitude; 2 and 3 are polar caps.
fn rootUVToDirection(root: f32, uv: vec2<f32>) -> vec3<f32> {
  if (root >= CAP_ROOT_START) {
    let p = (uv * 2.0 - 1.0) * CAP_HALF;
    let s = 1.0 + dot(p, p);
    if (root < SOUTH_ROOT_START) { return vec3<f32>(-2.0 * p.y / s, 2.0 / s - 1.0, -2.0 * p.x / s); }
    return vec3<f32>(2.0 * p.y / s, 1.0 - 2.0 / s, -2.0 * p.x / s);
  }
  let longitude = (uv.x - 1.0 + root) * 3.14159265;
  let latitude = (uv.y - 0.5) * 3.14159265;
  return vec3<f32>(cos(latitude) * cos(longitude), sin(latitude), -cos(latitude) * sin(longitude));
}

// A root's u and v as rootDelta's center: latitude and longitude, or a cap's x and y.
fn rootPlane(root: f32, uv: vec2<f32>) -> vec2<f32> {
  if (root >= CAP_ROOT_START) { return (uv * 2.0 - 1.0) * CAP_HALF; }
  return vec2<f32>((uv.y - 0.5) * 3.14159265, (uv.x - 1.0 + root) * 3.14159265);
}

// Change in the unit direction from a tile's center, without subtracting two nearly equal
// vectors: deep tiles are far smaller than one float32 step of a planet-sized position.
// `center` is latitude and longitude, or a cap's x and y. `local` is the offset from it:
// east and north radians on a geographic root, cap x and y on a cap.
fn rootDelta(root: f32, center: vec2<f32>, local: vec2<f32>) -> vec3<f32> {
  if (root >= CAP_ROOT_START) {
    let s0 = 1.0 + dot(center, center);
    let ds = 2.0 * dot(center, local) + dot(local, local);
    let d = 2.0 / (s0 * (s0 + ds));
    let p = (local * s0 - center * ds) * d;
    let w = -ds * d;
    if (root < SOUTH_ROOT_START) { return vec3<f32>(-p.y, w, -p.x); }
    return vec3<f32>(p.y, -w, -p.x);
  }
  let sinLat = sin(center.x);
  let cosLat = cos(center.x);
  let sinLon = sin(center.y);
  let cosLon = cos(center.y);
  let halfLat = sin(local.y * 0.5);
  let halfLon = sin(local.x * 0.5);
  let latStep = sin(local.y);
  let lonStep = sin(local.x);
  let dSinLat = -2.0 * halfLat * halfLat * sinLat + cosLat * latStep;
  let dCosLat = -2.0 * halfLat * halfLat * cosLat - sinLat * latStep;
  let dSinLon = -2.0 * halfLon * halfLon * sinLon + cosLon * lonStep;
  let dCosLon = -2.0 * halfLon * halfLon * cosLon - sinLon * lonStep;
  return vec3<f32>(
    dCosLat * cosLon + cosLat * dCosLon + dCosLat * dCosLon,
    dSinLat,
    -(dCosLat * sinLon + cosLat * dSinLon + dCosLat * dSinLon)
  );
}
