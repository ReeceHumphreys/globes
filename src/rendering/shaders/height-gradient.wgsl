fn heightGradient(heightTiles: texture_2d_array<f32>, coord: vec2<u32>, layer: f32) -> vec4<f32> {
  let size=vec2<i32>(textureDimensions(heightTiles));
  let p=vec2<i32>(coord);
  let a=textureLoad(heightTiles,clamp(p+vec2<i32>(1,0),vec2<i32>(0),size-1),i32(layer),0).rg;
  let b=textureLoad(heightTiles,clamp(p-vec2<i32>(1,0),vec2<i32>(0),size-1),i32(layer),0).rg;
  let c=textureLoad(heightTiles,clamp(p+vec2<i32>(0,1),vec2<i32>(0),size-1),i32(layer),0).rg;
  let d=textureLoad(heightTiles,clamp(p-vec2<i32>(0,1),vec2<i32>(0),size-1),i32(layer),0).rg;
  return vec4<f32>(decodeHeight(a)-decodeHeight(b),decodeHeight(c)-decodeHeight(d),0.0,0.0);
}
