// Bounded height-field ray march, evaluated per mesh vertex then interpolated.
// Distances/heights stay in meters; the radial altitude formula avoids subtracting
// two almost equal Moon-sized floats. Elevation, not visible geometry, supplies occluders.
// Visibility feathers instead of clipping to 0/1, so the interpolated edge is a
// penumbra rather than a hard triangle cut. WebGPU allows 16 varyings, which is
// already full, so this stays in the vertex stage.
fn terrainSunlight(heightTiles: texture_2d_array<f32>, indexMap: texture_2d<f32>, direction: vec3<f32>, heightMeters: f32, sun: vec3<f32>, radius: f32, minHeight: f32, coreSize: f32, gutter: f32, maxLevel: f32, maxHeight: f32, sampleSpacing: f32, cellRadians: f32, enabled: f32, steps: f32) -> f32 {
  let bodyVisibility = solarVisibility(direction,sun,radius,heightMeters,minHeight);
  // steps < 1 is the draw-time cache miss. A close drag would otherwise march
  // every vertex of every new patch; the compute bake fills those patches later.
  if(bodyVisibility<=0.0 || enabled<0.5 || steps<1.0) { return bodyVisibility; }
  let d=normalize(direction);
  let light=normalize(sun);
  let incidence=dot(d,light);
  let r=radius+heightMeters;
  // Max theoretical terrain horizon for the supplied elevation range, capped
  // at 400 km. Finite sampling can miss narrow distant peaks; this is not a PSR solver.
  let distanceLimit=min(400000.0,sqrt(max(0.0,2.0*radius*(maxHeight-heightMeters+10.0)))+1000.0);
  let start=max(1.0,sampleSpacing*0.5);
  let count=clamp(steps,8.0,48.0);
  let growth=pow(max(1.01,distanceLimit/start),1.0/max(1.0,count-1.0));
  // Numerical bias is small compared with the sampled DEM footprint. It does
  // not grow with scene/global coordinates or suppress real crater-rim heights.
  let bias=max(0.5,sampleSpacing*0.002);
  // Fully lit once the ray clears the terrain by this much, so DEM noise on the
  // sunward side does not darken open ground. The dark side of the ramp is the penumbra.
  let litEdge=max(bias,sampleSpacing*0.012);
  // About two mesh cells of ground feather, so neighboring vertices share the
  // edge instead of snapping from lit to dark. Farther along the ray it widens
  // like a solar disc a bit larger than the real one (~0.0047 rad).
  let cellMeters=max(cellRadians,0.0)*radius;
  let meshFeather=cellMeters*2.2*max(incidence,0.2);
  var distance=start;
  var visibility=1.0;
  for(var i=0;i<48;i++) {
    if(f32(i)>=count || distance>distanceLimit*1.001) { break; }
    let q=distance/r;
    let change=2.0*q*incidence+q*q;
    let rayHeight=heightMeters+r*change/(sqrt(max(0.000001,1.0+change))+1.0);
    if(rayHeight>maxHeight+bias && incidence>=0.0) { break; }
    let rayDirection=normalize(d+light*q);
    let ground=shadowHeight(heightTiles,indexMap,rayDirection,coreSize,gutter,maxLevel);
    let opening=max(length(cross(light,rayDirection)),0.1);
    let penumbraMeters=max(distance*0.014,meshFeather)/opening;
    let clearance=rayHeight-ground;
    visibility=min(visibility,smoothstep(-penumbraMeters,litEdge,clearance));
    if(visibility<=0.001) { return 0.0; }
    distance*=growth;
  }
  return visibility * bodyVisibility;
}
