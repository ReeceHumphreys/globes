// What the air does to whatever was drawn behind each pixel, from the view tables. Rays are
// in the stretched body frame, where the ellipsoid is a sphere and height is r - bottom.
fn atmosphereSky(
  backdrop: vec3<f32>, viewPosition: vec3<f32>, direction: vec3<f32>, empty: f32,
  stretchedFromView: mat3x3<f32>, o: vec3<f32>, sun: vec3<f32>, bottom: f32, top: f32,
  polarRatio: f32, size: vec3<f32>,
  gathered: texture_3d<f32>, passed: texture_3d<f32>, tableSampler: sampler,
  lut: texture_2d<f32>, lutSampler: sampler, skyLight: texture_2d<f32>, skySampler: sampler,
  intensity: f32, nightLight: vec3<f32>,
  cloudMap: texture_2d<f32>, cloudSampler: sampler,
  cloudRadius: f32, cloudStrength: f32, pixelAngle: f32, cloudTexels: f32
) -> vec3<f32> {
  let stretched = stretchedFromView * normalize(direction);
  let scale = length(stretched);
  let dir = stretched / scale;
  // Ray against the top of the atmosphere, via the closest approach to the center:
  // this avoids subtracting two planet-sized squares when the camera is far away.
  let b = dot(o, dir);
  let closest = length(o - dir * b);
  if (closest >= top) { return backdrop; }
  let half = sqrt((top - closest) * (top + closest));
  let t0 = max(0.0, -b - half);
  var end = -b + half;
  if (end <= 0.0) { return backdrop; }
  var ground = false;
  if (closest < bottom) {
    let hit = -b - sqrt((bottom - closest) * (bottom + closest));
    if (hit > 0.0) { end = hit; ground = true; }
  }
  var t1 = end;
  if (empty < 0.5) { t1 = min(t1, length(viewPosition) * scale); }
  if (t1 <= t0) { return backdrop; }

  let r = max(length(o), bottom + 1.0);
  let up = o / length(o);
  let bands = viewBands(r, bottom, top);
  let band = bandPosition(atan2(closest, -b), bands, ground);
  let sideSun = sun - up * dot(sun, up);
  let sideView = dir - up * dot(dir, up);
  let azimuth = atan2(length(cross(sideSun, sideView)), dot(sideSun, sideView)) / 3.14159265;
  let rows = size.y * 0.5;
  let u = (azimuth * (size.x - 1.0) + 0.5) / size.x;
  let v = (band * (rows - 1.0) + select(rows, 0.0, ground) + 0.5) / size.y;
  let span = max(end - t0, 1.0);
  let w = (sqrt((t1 - t0) / span) * (size.z - 1.0) + 0.5) / size.z;
  let far = textureSampleLevel(gathered, tableSampler, vec3<f32>(u, v, w), 0.0).rgb;
  let through = textureSampleLevel(passed, tableSampler, vec3<f32>(u, v, w), 0.0).rgb;
  var result = backdrop * through + far;

  if (cloudStrength > 0.0 && closest < cloudRadius) {
    let hit = -b - sqrt((cloudRadius - closest) * (cloudRadius + closest));
    if (hit > t0 && hit < t1) {
      let point = (o + dir * hit) / cloudRadius;
      // Stretched back, the sphere's direction becomes the ellipsoid's normal.
      let normal = normalize(point * vec3<f32>(1.0, 1.0 / polarRatio, 1.0));
      let slant = max(-dot(dir, point), 0.05);
      let pixelMeters = hit * pixelAngle / sqrt(slant);
      let lod = log2(max(1.0, pixelMeters / cloudTexels));
      let mu = dot(point, sun);
      let sunlight = sunTransmittance(lut, lutSampler, bottom, top, cloudRadius, mu) * intensity;
      let sky = textureSampleLevel(skyLight, skySampler, vec2<f32>(mu * 0.5 + 0.5, 0.5), 0.0).rgb;
      let cloud = cloudLight(cloudMap, cloudSampler, normal, cloudRadius, lod, pixelMeters,
        slant, cloudStrength, mu, sun, sunlight, sky * intensity + nightLight);
      if (cloud.a > 0.0) {
        // Gathered light splits at the layer: what is before it stays, and what is
        // past it, with the backdrop, shows through the gaps.
        let wn = (sqrt((hit - t0) / span) * (size.z - 1.0) + 0.5) / size.z;
        let near = textureSampleLevel(gathered, tableSampler, vec3<f32>(u, v, wn), 0.0).rgb;
        let toCloud = textureSampleLevel(passed, tableSampler, vec3<f32>(u, v, wn), 0.0).rgb;
        result = near + toCloud * cloud.rgb * cloud.a + (result - near) * (1.0 - cloud.a);
      }
    }
  }
  return result;
}
