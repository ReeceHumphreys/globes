fn sampleSurfaceHeight(
  heightTiles: texture_2d_array<f32>,
  direction: vec3<f32>, localUV: vec2<f32>, layers: vec2<f32>,
  bestUV: vec4<f32>, parentUV: vec4<f32>, transition: f32, enabled: f32, encoding: vec2<f32>
) -> f32 {
  if (enabled < 0.5) { return 0.0; }
  if (transition >= 1.0) { return sampleHeightLayer(heightTiles, bestUV.xy + localUV * bestUV.zw, layers.x, encoding); }
  if (transition <= 0.0) { return sampleHeightLayer(heightTiles, parentUV.xy + localUV * parentUV.zw, layers.y, encoding); }
  let parent = sampleHeightLayer(heightTiles, parentUV.xy + localUV * parentUV.zw, layers.y, encoding);
  let fine = sampleHeightLayer(heightTiles, bestUV.xy + localUV * bestUV.zw, layers.x, encoding);
  return mix(parent, fine, transition);
}
