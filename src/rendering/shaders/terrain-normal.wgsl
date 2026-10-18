// Mesh triangles are coarser than the height grid, so the normal comes from global height samples.
// East × north points outward. Same difference as reliefNormal in src/elevation/relief-normal.ts.
fn reliefNormal(heightMap: texture_2d<f32>, direction: vec3<f32>, radius: f32, enabled: f32) -> vec3<f32> {
  let d = normalize(direction);
  if (enabled < 0.5) {
    return d;
  }
  let dimensions = vec2<f32>(textureDimensions(heightMap));
  let lonStep = 6.283185307179586 / dimensions.x;
  let latStep = 3.141592653589793 / dimensions.y;
  let axis = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(d.y) > 0.8);
  let east = normalize(cross(axis, d));
  let north = cross(d, east);
  var position = array<vec3<f32>, 4>(d, d, d, d);
  let offset = array<vec3<f32>, 4>(east * lonStep, -east * lonStep, north * latStep, -north * latStep);
  for (var i = 0; i < 4; i++) {
    let dir = normalize(d + offset[i]);
    let height = sampleElevation(heightMap, dir);
    position[i] = dir * (radius + height);
  }
  return normalize(cross(position[0] - position[1], position[2] - position[3]));
}
