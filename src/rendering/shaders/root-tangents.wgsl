// How the surface normal changes per unit of a root's u and v: the columns of the tangent
// frame, used to turn a height slope into a normal without differencing positions.
fn rootTangents(root: f32, direction: vec3<f32>) -> mat2x3<f32> {
  let d = normalize(direction);
  if (root >= CAP_ROOT_START) {
    let width = 2.0 * CAP_HALF;
    var x: f32;
    var y: f32;
    if (root < SOUTH_ROOT_START) {
      x = -d.z / (1.0 + d.y);
      y = -d.x / (1.0 + d.y);
    } else {
      x = -d.z / (1.0 - d.y);
      y = d.x / (1.0 - d.y);
    }
    let s = 1.0 + x * x + y * y;
    let k = 4.0 / (s * s);
    if (root < SOUTH_ROOT_START) {
      return mat2x3<f32>(
        vec3<f32>(k * x * y, -k * x, k * x * x - 2.0 / s) * width,
        vec3<f32>(k * y * y - 2.0 / s, -k * y, k * x * y) * width
      );
    }
    return mat2x3<f32>(
      vec3<f32>(-k * x * y, k * x, k * x * x - 2.0 / s) * width,
      vec3<f32>(2.0 / s - k * y * y, k * y, k * x * y) * width
    );
  }
  let h = max(length(d.xz), 0.0001);
  return mat2x3<f32>(
    vec3<f32>(d.z, 0.0, -d.x) * 3.14159265,
    vec3<f32>(-d.y * d.x / h, h, -d.y * d.z / h) * 3.14159265
  );
}
