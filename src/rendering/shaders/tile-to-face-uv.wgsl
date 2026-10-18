// tileUV = (x / 2^level, y / 2^level, 1 / 2^level, 1 / 2^level).
// The input grid covers [0,1]²; the output covers this tile's face region.
fn tileToFaceUV(localUV: vec2<f32>, tileUV: vec4<f32>) -> vec2<f32> {
  return tileUV.xy + localUV * tileUV.zw;
}
