fn sampleHeightLayer(heightTiles: texture_2d_array<f32>, uv: vec2<f32>, layer: f32) -> f32 {
  let size = vec2<i32>(textureDimensions(heightTiles));
  let p = clamp(uv * vec2<f32>(size) - 0.5, vec2<f32>(0.0), vec2<f32>(size - 1));
  let base = vec2<i32>(floor(p));
  let next = min(base + 1, size - 1);
  let weight = fract(p);
  let a = textureLoad(heightTiles, base, i32(layer), 0).rg;
  let b = textureLoad(heightTiles, vec2<i32>(next.x, base.y), i32(layer), 0).rg;
  let c = textureLoad(heightTiles, vec2<i32>(base.x, next.y), i32(layer), 0).rg;
  let d = textureLoad(heightTiles, next, i32(layer), 0).rg;
  let packed = mix(mix(a,b,weight.x), mix(c,d,weight.x), weight.y);
  return decodeHeight(packed);
}
