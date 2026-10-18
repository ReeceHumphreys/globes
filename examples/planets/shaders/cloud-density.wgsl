// WGSL adaptation of sampleWeather/sampleMedia in Takram three-clouds.
// Source revision b012ad06d858fc035d88aacfd73f092f93c994e4,
// packages/clouds/src/shaders/clouds.glsl, lines 61-99 and 116-156.
// Copyright (c) 2024 Shota Matsuda. MIT; full notices: ../assets/clouds/LICENSE.txt.
// This pure helper is also tested against an independent upstream-equation oracle.
fn cloudDensityFromSamples(
  heightFraction: f32, weather: f32, shape: f32, detail: f32,
  coverage: f32, detailAmount: f32
) -> f32 {
  if (heightFraction <= 0.0 || heightFraction >= 1.0 || coverage <= 0.0) { return 0.0; }
  let h = clamp(heightFraction, 0.0, 1.0);
  let biased = pow(h, 0.35);
  let rounded = clamp(biased * 2.0 - 1.0, -1.0, 1.0);
  let heightScale = 1.0 - rounded * rounded;
  let filterWidth = 0.6;
  let factor = 1.0 - coverage * heightScale;
  var density = clamp((mix(weather, 1.0, filterWidth) - factor) / filterWidth, 0.0, 1.0);
  // Remap against the precomputed Perlin-Worley body, rather than multiplying
  // arbitrary noise into the weather density.
  let minimum = 1.0 - shape;
  density = clamp((density - minimum) / max(1e-6, 1.0 - minimum), 0.0, 1.0);
  if (detailAmount > 0.0) {
    // Upstream's fluffy upper edges and wispy lower edges use different erosion.
    let heightMix = clamp((h - 0.2) / 0.2, 0.0, 1.0);
    let modifier = mix(pow(detail, 6.0), 1.0 - detail, heightMix);
    let eroded = clamp((density * 2.0 - modifier * 0.5) / (1.0 - modifier * 0.5), 0.0, 1.0);
    // Endpoints match upstream detail on/off. Fade between them to avoid an LOD pop.
    density = mix(density, eroded, detailAmount);
  }
  // Default CloudLayer density profile: expTerm=0, linearTerm=.75, constant=.25.
  return clamp(density * (0.75 * h + 0.25), 0.0, 1.0);
}
