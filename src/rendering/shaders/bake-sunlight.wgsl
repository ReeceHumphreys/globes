fn bakeSunlight(heightMap: texture_2d<f32>, heightTiles: texture_2d_array<f32>, indexMap: texture_2d<f32>, coord: vec2<u32>, segments: f32, faceUV: vec4<f32>, rotation: vec2<f32>, layers: vec2<f32>, bestUV: vec4<f32>, parentUV: vec4<f32>, sun: vec3<f32>, radius: f32, minHeight: f32, maxHeight: f32, coreSize: f32, gutter: f32, maxLevel: f32, steps: f32) -> vec4<f32> {
  let uv=vec2<f32>(coord)/segments;
  let direction=faceUVToDirection(faceUV.xy+uv*faceUV.zw,rotation);
  let height=sampleSurfaceHeight(heightMap,heightTiles,direction,uv,layers,bestUV,parentUV,1.0,1.0,1.0);
  let spacing=2.0*radius*faceUV.z/max(abs(bestUV.z)*f32(textureDimensions(heightTiles).x),0.000001);
  let light=terrainSunlight(heightMap,heightTiles,indexMap,direction,height,sun,radius,minHeight,1.0,coreSize,gutter,maxLevel,maxHeight,spacing,2.0*faceUV.z/segments,1.0,steps);
  return vec4<f32>(light,0.0,0.0,0.0);
}
