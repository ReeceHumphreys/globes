fn positionToLatLon(position: vec3<f32>) -> vec2<f32> {
  // +Y is north, +X is longitude 0, -Z is 90 degrees east (right-handed, Y-up).
  // atan2 retains the horizontal component near either pole. Normalizing then
  // taking asin rounds y to +/-1 in f32 and collapses nearby positions together.
  let horizontal = length(position.xz);
  let latitude = atan2(position.y, horizontal);

  // Longitude is undefined at the poles; choose 0 there deterministically.
  var longitude = 0.0;
  if (horizontal > 0.0) {
    longitude = atan2(-position.z, position.x);
  }

  // Components are (latitude, longitude), both in radians.
  return vec2<f32>(latitude, longitude);
}
