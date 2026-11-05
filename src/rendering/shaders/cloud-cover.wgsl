// Cloud cover at a surface normal, 0 to 1. The floor drops the map's faint grey, which
// would otherwise veil clear sky.
fn cloudCover(map: texture_2d<f32>, mapSampler: sampler, normal: vec3<f32>, lod: f32) -> f32 {
  let latLon = positionToLatLon(normal);
  let uv = latLonToUV(latLon.x, latLon.y);
  // An explicit level: screen derivatives jump at the map's date-line seam.
  return smoothstep(0.08, 0.7, textureSampleLevel(map, mapSampler, uv, lod).r);
}
