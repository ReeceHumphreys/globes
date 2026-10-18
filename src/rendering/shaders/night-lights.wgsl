// shortcut: one equirectangular image, not a second resident tile cache. The instanced grid is already at the vertex-attribute budget. Upgrade when this map is soft at the altitude you use.
fn addNightLights(day: vec3<f32>, lights: vec3<f32>, radial: vec3<f32>, sun: vec3<f32>, enabled: f32) -> vec3<f32> {
  // Radial, not the relief normal: a sunlit crater wall on the night side stays unlit.
  let nightAmount = 1.0 - smoothstep(-0.12, 0.02, dot(normalize(radial), normalize(sun)));
  return day + lights * nightAmount * enabled;
}
