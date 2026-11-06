// Dominant cube face of a direction, then its face UV from 0 to 1. Matches facePoint in roots.ts.
fn facePoint(direction: vec3<f32>) -> vec3<f32> {
  let a = abs(direction);
  var face = 0.0;
  var uv = vec2<f32>(0.5);
  if (a.x >= a.y && a.x >= a.z) {
    if (direction.x >= 0.0) { face = 0.0; uv = vec2<f32>(-direction.z, direction.y) / a.x; }
    else { face = 1.0; uv = vec2<f32>(direction.z, direction.y) / a.x; }
  } else if (a.y >= a.z) {
    if (direction.y >= 0.0) { face = 2.0; uv = vec2<f32>(direction.x, -direction.z) / a.y; }
    else { face = 3.0; uv = vec2<f32>(direction.x, direction.z) / a.y; }
  } else {
    if (direction.z >= 0.0) { face = 4.0; uv = vec2<f32>(direction.x, direction.y) / a.z; }
    else { face = 5.0; uv = vec2<f32>(-direction.x, direction.y) / a.z; }
  }
  return vec3<f32>(face, uv * 0.5 + 0.5);
}
