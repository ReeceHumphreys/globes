// Display treatment for the colorized Viking mosaic. Work in linear color so
// both rusty terrain and blue-gray markings gain chroma without tinting ice.
fn marsPresentationColor(color: vec3<f32>) -> vec3<f32> {
  let brightest = max(max(color.r, color.g), color.b);
  let darkest = min(min(color.r, color.g), color.b);
  let chroma = brightest - darkest;
  let luminance = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let vivid = max(vec3<f32>(0.0), vec3<f32>(luminance) + (color - vec3<f32>(luminance)) * 1.28);

  // Only red-dominant terrain receives the copper tint. Blue-gray terrain
  // retains its hue, while bright ice approaches the original mosaic color.
  let rusty = smoothstep(0.005, 0.08, color.r - color.b) * smoothstep(0.02, 0.12, chroma);
  let warm = vivid * mix(vec3<f32>(1.0), vec3<f32>(1.10, 0.98, 0.90), rusty);
  return mix(warm, color, smoothstep(0.45, 0.80, brightest));
}
