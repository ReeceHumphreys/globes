fn imageOverlay(
  map: texture_2d<f32>, mapSampler: sampler, uv: vec2<f32>, uvDx: vec2<f32>, uvDy: vec2<f32>
) -> vec4<f32> {
  return textureSampleGrad(map, mapSampler, uv, uvDx, uvDy);
}
