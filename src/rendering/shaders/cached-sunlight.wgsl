fn cachedTerrainSunlight(
  heightTiles: texture_2d_array<f32>, indexMap: texture_2d<f32>, cache: texture_2d<f32>, cacheFlags: f32, localUV: vec2<f32>, segments: f32, columns: f32,
  direction: vec3<f32>, heightMeters: f32, sun: vec3<f32>, radius: f32, minHeight: f32, coreSize: f32, gutter: f32, maxLevel: f32, maxHeight: f32, sampleSpacing: f32, cellRadians: f32, enabled: f32, steps: f32
) -> f32 {
  let slot=i32(u32(round(cacheFlags))%256u)-1;
  if(slot>=0 && enabled>0.5) {
    let grid=i32(segments)+1;
    let offset=vec2<i32>(slot%i32(columns),slot/i32(columns))*grid;
    let point=vec2<i32>(round(clamp(localUV,vec2<f32>(0.0),vec2<f32>(1.0))*segments));
    return textureLoad(cache,offset+point,0).r;
  }
  return terrainSunlight(heightTiles,indexMap,direction,heightMeters,sun,radius,minHeight,coreSize,gutter,maxLevel,maxHeight,sampleSpacing,cellRadians,enabled,0.0);
}
