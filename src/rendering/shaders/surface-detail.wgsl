// Ground-locked mottling for imagery that has been magnified past its texels.
// Sample the unit direction, not a meter position: a 1.7e6 m coordinate has no
// sub-meter fraction left. Scales are meters on the sphere. An octave drops out
// once it covers fewer than a couple of screen pixels.
fn cover(scale: f32, pixelMeters: f32) -> f32 {
  return smoothstep(2.0, 5.0, scale / max(pixelMeters, 0.0001));
}

fn hash13(cell: vec3<f32>) -> f32 {
  var p = fract(cell * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

fn valueNoise(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3<f32>(1.0, 0.0, 0.0)), u.x),
        mix(hash13(i + vec3<f32>(0.0, 1.0, 0.0)), hash13(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(hash13(i + vec3<f32>(0.0, 0.0, 1.0)), hash13(i + vec3<f32>(1.0, 0.0, 1.0)), u.x),
        mix(hash13(i + vec3<f32>(0.0, 1.0, 1.0)), hash13(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}

fn octave(direction: vec3<f32>, radius: f32, pixelMeters: f32, scale: f32) -> vec2<f32> {
  let c = cover(scale, pixelMeters);
  return vec2<f32>(valueNoise(direction * (radius / scale)) * c, c);
}

fn surfaceDetail(direction: vec3<f32>, radius: f32, pixelMeters: f32) -> f32 {
  if (pixelMeters <= 0.0) { return 1.0; }
  var sum = vec2<f32>(0.0, 0.0);
  sum += octave(direction, radius, pixelMeters, 64.0);
  sum += octave(direction, radius, pixelMeters, 16.0);
  sum += octave(direction, radius, pixelMeters, 4.0);
  if (sum.y <= 0.0) { return 1.0; }
  return mix(0.84, 1.16, sum.x / sum.y);
}

// 1 when a photo texel covers more than about two screen pixels.
fn detailWeight(texelsPerPixel: f32) -> f32 {
  if (texelsPerPixel <= 0.0) { return 0.0; }
  return 1.0 - smoothstep(0.55, 1.6, texelsPerPixel);
}
