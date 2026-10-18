fn heightGradient(heightTiles: texture_2d_array<f32>, coord: vec2<u32>, layer: f32) -> vec4<f32> {
  let size=vec2<i32>(textureDimensions(heightTiles));
  let p=vec2<i32>(coord);
  let a=textureLoad(heightTiles,clamp(p+vec2<i32>(1,0),vec2<i32>(0),size-1),i32(layer),0).rg;
  let b=textureLoad(heightTiles,clamp(p-vec2<i32>(1,0),vec2<i32>(0),size-1),i32(layer),0).rg;
  let c=textureLoad(heightTiles,clamp(p+vec2<i32>(0,1),vec2<i32>(0),size-1),i32(layer),0).rg;
  let d=textureLoad(heightTiles,clamp(p-vec2<i32>(0,1),vec2<i32>(0),size-1),i32(layer),0).rg;
  let weights=vec2<f32>(255.0,65280.0);
  let ha=dot(a,weights)*0.5-10000.0;let hb=dot(b,weights)*0.5-10000.0;
  let hc=dot(c,weights)*0.5-10000.0;let hd=dot(d,weights)*0.5-10000.0;
  return vec4<f32>(ha-hb,hc-hd,0.0,0.0);
}
