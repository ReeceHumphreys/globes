fn fragmentColor(
  faceColor: vec3<f32>, checkerColor: vec3<f32>,
  overviewColor: vec3<f32>, imageryEnabled: f32, tiledImageryEnabled: f32,
  tileColor: vec4<f32>, parentColor: vec4<f32>, transition: f32,
  normal: vec3<f32>, sun: vec3<f32>, view: vec3<f32>, shadingEnabled: f32,
  hapkeEnabled: f32, hapkeParameters: vec4<f32>, hapkeReference: f32, sunlight: f32, neutralTerrain: f32,
  radial: vec3<f32>, radius: f32, pixelMeters: f32, detailEnabled: f32,
  tileTexels: f32, parentTexels: f32, overviewTexels: f32
) -> vec3<f32> {
  let checkerResult = checkerColor * mix(vec3<f32>(1.0), faceColor, 0.3);
  // The normal is radial on the global grid and follows the height tile when one
  // is loaded, so a landing-site DTM can put crater walls into night. Multiply
  // only: photographed shadows stay in the picture.
  var shade = 1.0;
  // These are uniform switches: do not evaluate Hapke for an unlit/debug view.
  if (shadingEnabled > 0.5 && imageryEnabled > 0.5) {
    let ndotl = dot(normalize(normal), normalize(sun));
    var reflectance = max(ndotl, 0.0);
    if (hapkeEnabled > 0.5) {
      reflectance = hapkeReflectance(normal,sun,view,hapkeParameters,hapkeReference);
    }
    shade = shadowedShade(reflectance, ndotl, sunlight);
  }
  // Blend source colors first; one lighting multiplication gives the same result.
  let parentResult = mix(overviewColor, parentColor.rgb, parentColor.a);
  let tileResult = mix(parentResult, tileColor.rgb, tileColor.a * transition);
  var surface = mix(overviewColor, tileResult, tiledImageryEnabled);
  // Break up tiles that have run out of resolution. Sharp imagery, including
  // Apollo where those tiles are resident, keeps weight 0.
  let fine = tileColor.a * transition * tiledImageryEnabled;
  let mid = parentColor.a * (1.0 - fine) * tiledImageryEnabled;
  let texels = fine * tileTexels + mid * parentTexels + max(0.0, 1.0 - fine - mid) * overviewTexels;
  var weight = 0.0;
  if (detailEnabled > 0.5) { weight = detailWeight(texels); }
  if (weight > 0.001) {
    let grain = surfaceDetail(radial, radius, pixelMeters);
    surface *= mix(vec3<f32>(1.0), vec3<f32>(grain), weight);
  }
  let terrainResult = mix(surface, vec3<f32>(0.35), neutralTerrain);
  return mix(checkerResult, terrainResult * shade, imageryEnabled);
}
