// Return local-space position; Three.js applies the model and camera transforms.
fn vertexPosition(
  position: vec3<f32>,
  radius: f32,
  tileSize: f32,
  tileRoot: f32,
  tileAnchor: vec3<f32>,
  tileUV: vec2<f32>,
  segments: f32,
  heightMeters: f32,
  heightRange: f32,
  tile: vec3<f32>,
  e2: f32,
  cameraOffset: vec3<f32>
) -> vec3<f32> {
  // The shared 1x1 grid, as an offset from this tile's center. Sizes are meters: radians
  // of latitude and longitude times the radius, or cap units times twice the radius.
  var local = position.xy * tileSize / radius;
  if (tileRoot >= CAP_ROOT_START) { local *= 0.5; }
  // Only the small change around the patch's anchor; the CPU anchor is camera-relative.
  let change = rootDelta(tileRoot, rootPlane(tileRoot, tile.xy + 0.5 * tile.z), local);
  let delta = change * radius;
  let direction = normalize(rootUVToDirection(tileRoot, tileUV));
  // Short inward walls cover gaps between coarse and fine edge polylines.
  let skirtDepth = heightRange + max(0.02, 4.0 * tileSize * tileSize / (radius * segments * segments));
  // The anchor is relative to the camera's sphere point, so the shape enters as a difference.
  let shape = ellipsoidOffset(direction, radius, e2) - cameraOffset;
  return tileAnchor + delta + shape + direction * (heightMeters - position.z * skirtDepth);
}
