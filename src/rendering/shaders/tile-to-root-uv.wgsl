// tileUV = (x, y, width, height) of a tile inside a larger 0..1 square. Heights can be negative.
// The input grid covers [0,1]²; the output covers the tile's region of that square.
fn tileToRootUV(localUV: vec2<f32>, tileUV: vec4<f32>) -> vec2<f32> {
  return tileUV.xy + localUV * tileUV.zw;
}
