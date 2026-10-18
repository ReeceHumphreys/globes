// Cloud marcher and density sampling adapted from Takram three-clouds.
// Copyright (c) 2024 Shota Matsuda. MIT: ../assets/clouds/LICENSE.txt.
// Scope, explicit adaptations and source revisions: docs/clouds.md.
fn marchClouds(
  origin: vec3<f32>, direction: vec3<f32>, sun: vec3<f32>,
  radius: f32, layer: vec2<f32>, coverage: f32, steps: u32, maxDistance: f32,
  weatherMap: texture_2d<f32>, weatherSampler: sampler,
  shapeMap: texture_3d<f32>, shapeSampler: sampler,
  detailMap: texture_3d<f32>, detailSampler: sampler, pixelAngle: f32,
  sunLight: vec3<f32>, skyLight: vec3<f32>
) -> vec4<f32> {
  if (coverage <= 0.0) { return vec4<f32>(0.0); }
  let outer = cloudSphere(origin, direction, radius + layer.x + layer.y);
  let start = max(0.0, outer.x);
  let end = min(maxDistance, outer.y);
  if (end <= start) { return vec4<f32>(0.0); }
  let inner = cloudSphere(origin, direction, radius + layer.x);
  var firstEnd = end;
  var secondStart = end;
  if (inner.y > start && inner.x < end) {
    firstEnd = clamp(inner.x, start, end);
    secondStart = clamp(inner.y, start, end);
  }
  let firstLength = firstEnd-start;
  let totalLength = firstLength + end-secondStart;
  if (totalLength <= 0.0) { return vec4<f32>(0.0); }
  let count = clamp(steps, 16u, 160u);
  let step = totalLength / f32(count);
  var transmittance = 1.0;
  var radiance = vec3<f32>(0.0);
  for (var i = 0u; i < 160u; i++) {
    if (i >= count || transmittance < 0.01) { break; }
    let arc = (f32(i)+0.5)*step;
    var distance = start+arc;
    if (arc >= firstLength) { distance = secondStart+arc-firstLength; }
    let p = origin+direction*distance;
    let footprint = distance * pixelAngle;
    let detailAmount = select(0.0, 1.0, steps > 48u);
    let density = cloudDensity(p,radius,layer,coverage,weatherMap,weatherSampler,
      shapeMap,shapeSampler,detailMap,detailSampler,footprint,detailAmount);
    if (density > 0.001) {
      // Upstream densityScale .2 and scatteringCoefficient 1 are per meter;
      // all ray distances here are kilometers.
      let opacity = 1.0-exp(-density*200.0*step);
      let opticalDepth = cloudSun(p,sun,radius,layer,coverage,weatherMap,weatherSampler,
        shapeMap,shapeSampler,detailMap,detailSampler,footprint,detailAmount);
      let direct = cloudMultipleScattering(opticalDepth,dot(direction,sun));
      // Sky fill is approximate; the direct term includes a reduced-order multiple-scattering approximation.
      let skyGradient = clamp(((length(p)-radius-layer.x)/layer.y)*0.5+0.5,0.0,1.0);
      let source = sunLight*direct + skyLight*(skyGradient/12.5663706144);
      // Photographic terrain is not calibrated albedo. This explicit example
      // exposure compensation matches clouds to that background; not a physical
      // change to the upstream density/extinction model (see docs/clouds.md).
      radiance += transmittance*opacity*source*3.0;
      transmittance *= 1.0-opacity;
    }
  }
  // Premultiplied radiance and opacity; never add an opaque cloud sphere.
  return vec4<f32>(radiance,1.0-transmittance);
}

// All ray positions and distances use kilometers in the ECEF body frame.
fn cloudDensity(p: vec3<f32>, radius: f32, layer: vec2<f32>, coverage: f32,
  weatherMap: texture_2d<f32>, weatherSampler: sampler,
  shapeMap: texture_3d<f32>, shapeSampler: sampler,
  detailMap: texture_3d<f32>, detailSampler: sampler, footprint: f32, detailAmount: f32
) -> f32 {
  let h = (length(p) - radius - layer.x) / layer.y;
  if (h <= 0.0 || h >= 1.0 || coverage <= 0.0) { return 0.0; }
  let direction = normalize(p);
  let uv = vec2<f32>(atan2(direction.y,direction.x)/6.28318530718+0.5,
    acos(clamp(direction.z,-1.0,1.0))/3.14159265359);
  let weather = textureSampleLevel(weatherMap,weatherSampler,uv,0.0).r;
  // Takram repeats are .0003 and .006 cycles/m: .3 and 6 cycles/km.
  // The tile period is 3.3 km; its fine body features are much smaller. Filter toward the
  // measured volume mean rather than aliasing them into the global weather.
  var shape = 203.3604/255.0;
  if (footprint < 0.09) {
    let rawShape = textureSampleLevel(shapeMap,shapeSampler,p*0.3,0.0).r;
    shape = mix(rawShape,shape,smoothstep(0.012,0.09,footprint));
  }
  let detailWeight = detailAmount * (1.0-smoothstep(0.002,0.008,footprint));
  var detail = 0.0;
  if (detailWeight > 0.0) {
    detail = textureSampleLevel(detailMap,detailSampler,p*6.0,0.0).r;
  }
  return cloudDensityFromSamples(h,weather,shape,detail,coverage,detailWeight);
}
fn cloudSphere(origin: vec3<f32>, direction: vec3<f32>, radius: f32) -> vec2<f32> {
  let b = dot(origin, direction);
  let disc = b*b - dot(origin, origin) + radius*radius;
  if (disc < 0.0) { return vec2<f32>(-1.0); }
  let root = sqrt(disc);
  return vec2<f32>(-b-root, -b+root);
}
fn cloudPhase(cosTheta: f32, g: f32) -> f32 {
  // Normalized Henyey-Greenstein phase function, as in the upstream marcher.
  return (1.0-g*g) / (12.5663706144 * pow(max(0.01, 1.0+g*g-2.0*g*cosTheta), 1.5));
}
fn cloudSun(p: vec3<f32>, sun: vec3<f32>, radius: f32, layer: vec2<f32>, coverage: f32,
  weatherMap: texture_2d<f32>, weatherSampler: sampler,
  shapeMap: texture_3d<f32>, shapeSampler: sampler,
  detailMap: texture_3d<f32>, detailSampler: sampler, footprint: f32, detailAmount: f32
) -> f32 {
  if (cloudSphere(p,sun,radius).x > 0.0) { return 1e6; }
  // Upstream's local secondary march starts at 100 m and doubles step size.
  // No Beer shadow map is used here: only local cloud self-shadowing is captured.
  var opticalDepth = 0.0;
  var step = 0.1;
  var distance = 0.0;
  for (var i = 0u; i < 4u; i++) {
    opticalDepth += cloudDensity(p+sun*(distance+0.5*step),radius,layer,coverage,
      weatherMap,weatherSampler,shapeMap,shapeSampler,detailMap,detailSampler,
      footprint,detailAmount)*200.0*step;
    distance += step;
    step *= 2.0;
  }
  return opticalDepth;
}
// Reduced-cost version of Takram's multi-octave scattering approximation.
fn cloudMultipleScattering(opticalDepth: f32, cosTheta: f32) -> f32 {
  var contribution = 1.0;
  var attenuation = 1.0;
  var anisotropy = 1.0;
  var scattering = 0.0;
  for (var i = 0u; i < 4u; i++) {
    let phase = 0.85*cloudPhase(cosTheta,0.55*anisotropy)
      + 0.15*cloudPhase(cosTheta,-0.2*anisotropy);
    scattering += contribution*exp(-opticalDepth*attenuation)*phase;
    contribution *= 0.5;
    attenuation *= 0.5;
    anisotropy *= 0.5;
  }
  return scattering;
}
