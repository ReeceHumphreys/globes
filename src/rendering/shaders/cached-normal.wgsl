fn cachedSurfaceNormal(
  heightTiles: texture_2d_array<f32>, gradients: texture_2d_array<f32>, gradientSampler: sampler,
  direction: vec3<f32>, localUV: vec2<f32>, layers: vec2<f32>, bestUV: vec4<f32>, parentUV: vec4<f32>, transition: f32,
  face: f32, faceScale: vec2<f32>, radius: f32, enabled: f32, cacheFlags: f32
) -> vec3<f32> {
  if(enabled<0.5) {return normalize(direction);}
  // Parent derivatives use a different stencil. Preserve the original function
  // until the displayed height has completely settled and this slot is baked.
  if(transition<1.0 || layers.x<0.5 || !gradientsBaked(cacheFlags)) {
    return surfaceNormal(heightTiles,direction,localUV,layers,bestUV,parentUV,transition,face,faceScale,radius,enabled);
  }
  let slope=textureSampleLevel(gradients,gradientSampler,bestUV.xy+localUV*bestUV.zw,i32(layers.x),0.0).rg*sign(bestUV.zw);
  let step=vec2<f32>(1.0)/max(abs(bestUV.zw)*f32(textureDimensions(gradients).x),vec2<f32>(0.000001));
  return normalFromGradient(direction,slope,step,face,faceScale,radius);
}
