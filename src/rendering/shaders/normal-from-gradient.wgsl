fn normalFromGradient(direction: vec3<f32>, slope: vec2<f32>, step: vec2<f32>, face: f32, faceScale: vec2<f32>, radius: f32) -> vec3<f32> {
  let d=normalize(direction);
  var axisU = vec3<f32>(1.0,0.0,0.0);
  var axisV = vec3<f32>(0.0,1.0,0.0);
  switch i32(face) {
    case 0: { axisU = vec3<f32>(0.0,0.0,-1.0); }
    case 1: { axisU = vec3<f32>(0.0,0.0,1.0); }
    case 2: { axisV = vec3<f32>(0.0,0.0,-1.0); }
    case 3: { axisV = vec3<f32>(0.0,0.0,1.0); }
    case 5: { axisU = vec3<f32>(-1.0,0.0,0.0); }
    default: {}
  }
  // Differentiate the unit sphere analytically: avoid subtracting positions
  // around 1.7 million meters to recover a meter-scale surface normal.
  let tangentU = (axisU-d*dot(d,axisU)) / length(direction);
  let tangentV = (axisV-d*dot(d,axisV)) / length(direction);
  let edgeU = tangentU*(2.0*radius*faceScale.x*step.x) + d*slope.x;
  let edgeV = tangentV*(2.0*radius*faceScale.y*step.y) + d*slope.y;
  return normalize(cross(edgeU,edgeV));
}
