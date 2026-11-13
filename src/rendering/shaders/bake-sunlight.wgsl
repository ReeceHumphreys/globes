fn bakeSunlight(heightTiles: texture_2d_array<f32>, indexMap: texture_2d<f32>, coord: vec2<u32>, segments: f32, rootUV: vec3<f32>, root: f32, tileMeters: f32, layers: vec2<f32>, bestUV: vec4<f32>, parentUV: vec4<f32>, sun: vec3<f32>, radius: f32, minHeight: f32, maxHeight: f32, coreSize: f32, gutter: f32, maxLevel: f32, steps: f32, encoding: vec2<f32>) -> vec4<f32> {
  let uv=vec2<f32>(coord)/segments;
  let direction=rootUVToDirection(root,rootUV.xy+uv*rootUV.z);
  let height=sampleSurfaceHeight(heightTiles,direction,uv,layers,bestUV,parentUV,1.0,1.0,encoding);
  let spacing=tileMeters/max(abs(bestUV.z)*f32(textureDimensions(heightTiles).x),0.000001);
  let light=terrainSunlight(heightTiles,indexMap,direction,height,sun,radius,minHeight,coreSize,gutter,maxLevel,maxHeight,spacing,tileMeters/(radius*segments),1.0,steps,encoding);
  return vec4<f32>(light,0.0,0.0,0.0);
}
