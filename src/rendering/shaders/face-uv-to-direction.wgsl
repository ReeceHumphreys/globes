// Keep this unnormalized at vertices. Interpolating the cube coordinates then
// normalizing in the fragment stage avoids longitude interpolation across ±pi.
fn faceUVToDirection(faceUV: vec2<f32>, rotation: vec2<f32>) -> vec3<f32> {
  let p = vec3<f32>(faceUV - vec2<f32>(0.5), 0.5);
  let cx = cos(rotation.x);
  let sx = sin(rotation.x);
  let cy = cos(rotation.y);
  let sy = sin(rotation.y);
  let rx = vec3<f32>(p.x, cx*p.y-sx*p.z, sx*p.y+cx*p.z);
  return vec3<f32>(cy*rx.x+sy*rx.z, rx.y, -sy*rx.x+cy*rx.z);
}
