// Four explicit texel reads: no mipmaps, sRGB, or interpolation of packed bytes.
// CPU clearance uses the same pixel-center mapping and bilinear height function.
fn sampleElevation(heightMap: texture_2d<f32>, direction: vec3<f32>) -> f32 {
  let d = normalize(direction);
  let dimensions = vec2<i32>(textureDimensions(heightMap));
  let u = (atan2(-d.z,d.x)+3.141592653589793)/6.283185307179586;
  // atan2 stays accurate close to the poles, where acos loses f32 detail.
  let v = atan2(length(d.xz),d.y)/3.141592653589793;
  let p = vec2<f32>(u*f32(dimensions.x)-0.5, clamp(v*f32(dimensions.y)-0.5,0.0,f32(dimensions.y-1)));
  let base = vec2<i32>(floor(p));
  let weight = fract(p);
  let x0 = ((base.x % dimensions.x)+dimensions.x)%dimensions.x;
  let x1 = (x0+1)%dimensions.x;
  let y1 = min(base.y+1,dimensions.y-1);
  let a = textureLoad(heightMap,vec2<i32>(x0,base.y),0).rg;
  let b = textureLoad(heightMap,vec2<i32>(x1,base.y),0).rg;
  let c = textureLoad(heightMap,vec2<i32>(x0,y1),0).rg;
  let e = textureLoad(heightMap,vec2<i32>(x1,y1),0).rg;
  let encoded = mix(mix(a,b,weight.x),mix(c,e,weight.x),weight.y);
  return dot(encoded,vec2<f32>(255.0,65280.0))*0.5-10000.0;
}
