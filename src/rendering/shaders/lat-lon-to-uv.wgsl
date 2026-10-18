fn latLonToUV(latitude: f32, longitude: f32) -> vec2<f32> {
  // Inputs are radians: latitude [-pi/2, pi/2], east longitude [-pi, pi].
  // North-up equirectangular image with WebGPU's top-left texture origin:
  // u increases eastward (left to right); v increases southward (top to bottom).
  let pi = 3.141592653589793;
  let u = (longitude + pi) / (2.0 * pi);
  let v = (0.5 * pi - latitude) / pi;
  return vec2<f32>(u, v);
}
