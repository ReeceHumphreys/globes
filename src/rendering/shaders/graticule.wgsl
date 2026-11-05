// Latitude and longitude lines, a constant width on screen wherever they fall. Rates are
// radians per pixel, so foreshortened lines near the limb keep their width.
fn graticule(
  latitude: f32, longitude: f32, latitudeRate: f32, longitudeDx: f32, longitudeDy: f32,
  spacing: vec2<f32>, fineStrength: f32, width: f32, color: vec3<f32>, parallels: vec4<f32>
) -> vec4<f32> {
  let tau = 6.283185307;
  // A jump across the antimeridian is a wrap, not a huge step.
  let dx = longitudeDx - tau * round(longitudeDx / tau);
  let dy = longitudeDy - tau * round(longitudeDy / tau);
  let rate = max(vec2<f32>(latitudeRate, length(vec2<f32>(dx, dy))), vec2<f32>(1e-9));
  let position = vec2<f32>(latitude, longitude);
  let inner = vec2<f32>(width * 0.5 - 0.5);
  let outer = vec2<f32>(width * 0.5 + 0.5);

  var alpha = 0.0;
  var crowding = vec2<f32>(1.0);
  for (var i = 0; i < 2; i++) {
    let step = spacing[i];
    let pixels = abs(fract(position / step + 0.5) - 0.5) * step / rate;
    // Lines merge toward the poles and the limb: fade them before they fill in.
    let room = smoothstep(vec2<f32>(4.0), vec2<f32>(12.0), step / rate);
    if (i == 0) { crowding = room; }
    let line = (1.0 - smoothstep(inner, outer, pixels)) * room;
    alpha = max(alpha, max(line.x, line.y) * select(fineStrength, 1.0, i == 0));
  }

  // The equator and prime meridian are heavier, and named parallels are always drawn.
  let axes = 1.0 - smoothstep(inner * 2.0, outer * 2.0, abs(position) / rate);
  alpha = max(alpha, max(axes.x, axes.y * crowding.y));
  let named = abs(vec4<f32>(latitude) - parallels) / rate.x;
  let nearest = min(min(named.x, named.y), min(named.z, named.w));
  alpha = max(alpha, 1.0 - smoothstep(inner.x, outer.x, nearest));
  return vec4<f32>(color, alpha);
}
