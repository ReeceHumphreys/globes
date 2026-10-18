fn surfaceNormal(
  heightMap: texture_2d<f32>, heightTiles: texture_2d_array<f32>,
  direction: vec3<f32>, localUV: vec2<f32>, layers: vec2<f32>,
  bestUV: vec4<f32>, parentUV: vec4<f32>, transition: f32, tiled: f32,
  face: f32, faceScale: vec2<f32>, radius: f32, enabled: f32
) -> vec3<f32> {
  let d = normalize(direction);
  if (enabled < 0.5) { return d; }
  if (tiled < 0.5) { return reliefNormal(heightMap, direction, radius, enabled); }
  if (layers.x < 0.5) { return d; }
  let size = f32(textureDimensions(heightTiles).x);
  let step = vec2<f32>(1.0) / max(abs(bestUV.zw)*size, vec2<f32>(0.000001));
  let hp = sampleSurfaceHeight(heightMap,heightTiles,direction,localUV+vec2<f32>(step.x,0.0),layers,bestUV,parentUV,transition,tiled,1.0);
  let hm = sampleSurfaceHeight(heightMap,heightTiles,direction,localUV-vec2<f32>(step.x,0.0),layers,bestUV,parentUV,transition,tiled,1.0);
  let vp = sampleSurfaceHeight(heightMap,heightTiles,direction,localUV+vec2<f32>(0.0,step.y),layers,bestUV,parentUV,transition,tiled,1.0);
  let vm = sampleSurfaceHeight(heightMap,heightTiles,direction,localUV-vec2<f32>(0.0,step.y),layers,bestUV,parentUV,transition,tiled,1.0);
  return normalFromGradient(direction,vec2<f32>(hp-hm,vp-vm),step,face,faceScale,radius);
}
