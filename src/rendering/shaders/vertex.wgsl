// Return local-space position; Three.js applies the model and camera transforms.
fn vertexPosition(
  position: vec3<f32>,
  radius: f32,
  tileSize: vec2<f32>,
  tileRotation: vec2<f32>,
  tileAnchor: vec3<f32>,
  segments: f32,
  heightMeters: f32,
  heightRange: f32,
  tileCenter: vec3<f32>
) -> vec3<f32> {
  // 1. Scale the shared 1x1 grid to this tile's width and height.
  let scaled = vec3<f32>(position.xy * tileSize, 0.0);

  // 2. Rotate around X, then Y, matching the cube-face convention.
  // Rotation inputs are radians, shared by every vertex in this tile instance.
  let cx = cos(tileRotation.x);
  let sx = sin(tileRotation.x);
  let cy = cos(tileRotation.y);
  let sy = sin(tileRotation.y);
  let rotatedX = vec3<f32>(
    scaled.x,
    cx * scaled.y - sx * scaled.z,
    sx * scaled.y + cx * scaled.z
  );
  let rotated = vec3<f32>(
    cy * rotatedX.x + sy * rotatedX.z,
    rotatedX.y,
    -sy * rotatedX.x + cy * rotatedX.z
  );

  // 3. Compute only the small change around this patch's sphere anchor.
  // Algebraically normalize(q+d)-normalize(q), without subtracting two
  // almost equal planet-sized values. The CPU anchor is camera-relative.
  let q = tileCenter;
  let qLength = length(q);
  let s = dot(2.0*q + rotated, rotated) / dot(q,q);
  let stretch = sqrt(1.0+s);
  let delta = (rotated - q * (s / (1.0+stretch))) * (radius / (qLength*stretch));
  let direction = normalize(q + rotated);
  // Short inward walls cover gaps between coarse and fine edge polylines.
  let skirtDepth = heightRange + max(0.02, 4.0 * tileSize.x * tileSize.x / (radius * segments * segments));
  return tileAnchor + delta + direction * (heightMeters - position.z * skirtDepth);
}
