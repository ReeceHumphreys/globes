// Fraction of sunlight reaching radius r from a sun at zenith cosine mu: the
// transmittance table, with the same mapping as transmittanceToSun in model.ts.
// The sun is a disc, so light fades out over its angular size at the horizon.
fn sunTransmittance(lut: texture_2d<f32>, lutSampler: sampler, bottom: f32, top: f32, r: f32, mu: f32) -> vec3<f32> {
  let H = sqrt(top * top - bottom * bottom);
  let rho = sqrt(max(0.0, r * r - bottom * bottom));
  let d = max(0.0, -r * mu + sqrt(max(0.0, r * r * (mu * mu - 1.0) + top * top)));
  let dMin = top - r;
  let dMax = rho + H;
  let x = clamp((d - dMin) / max(dMax - dMin, 1.0), 0.0, 1.0);
  let y = clamp(rho / H, 0.0, 1.0);
  let size = vec2<f32>(textureDimensions(lut));
  let uv = (vec2<f32>(x, y) * (size - 1.0) + 0.5) / size;
  let horizon = -sqrt(max(0.0, 1.0 - (bottom / r) * (bottom / r)));
  let visible = smoothstep(horizon - 0.0047, horizon + 0.0047, mu);
  return textureSampleLevel(lut, lutSampler, uv, 0.0).rgb * visible;
}
