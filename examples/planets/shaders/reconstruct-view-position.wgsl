// WebGPU depth is already in [0,1], including reversed depth. UV origin is top-left.
// Only call for a geometry sample, not the cleared far-plane depth.
fn reconstructViewPosition(uv: vec2<f32>, depth: f32, inverseProjection: mat4x4<f32>) -> vec3<f32> {
  let clip = vec4<f32>(uv.x*2.0-1.0,1.0-uv.y*2.0,depth,1.0);
  let view = inverseProjection*clip;
  return view.xyz/view.w;
}
