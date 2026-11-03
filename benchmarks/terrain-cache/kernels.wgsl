// Experimental only: production shader functions are prepended by the harness.
struct Parameters {
  faceUV: vec4<f32>, bestUV: vec4<f32>, parentUV: vec4<f32>,
  // sample-grid width, fine layer, parent layer, fade
  record: vec4<f32>,
  // sun xyz, ray-march step count
  solar: vec4<f32>,
  // radius, minimum height, maximum height, source max level
  limits: vec4<f32>,
  // height core, gutter, mesh-cell radians, height sample spacing
  sampling: vec4<f32>,
  // face id (separate from the height cache's layer address)
  face: vec4<f32>,
}
@group(0) @binding(1) var heights: texture_2d_array<f32>;
@group(0) @binding(2) var heightIndex: texture_2d<f32>;
@group(0) @binding(3) var gradients: texture_2d_array<f32>;
@group(0) @binding(4) var linearSampler: sampler;
@group(0) @binding(5) var gradientOutput: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(6) var sunOutput: texture_storage_2d_array<r32float, write>;
@group(0) @binding(7) var sunCache: texture_2d_array<f32>;
@group(0) @binding(8) var<uniform> params: Parameters;
@group(0) @binding(9) var<storage,read_write> results: array<vec4<f32>>;

fn rawCubeDirection(uv: vec2<f32>) -> vec3<f32> {
  let p=(params.faceUV.xy+uv*params.faceUV.zw)*2.0-1.0;
  switch i32(params.face.x) {
    case 0: { return vec3<f32>(1.0,p.y,-p.x); }
    case 1: { return vec3<f32>(-1.0,p.y,p.x); }
    case 2: { return vec3<f32>(p.x,1.0,-p.y); }
    case 3: { return vec3<f32>(p.x,-1.0,p.y); }
    case 4: { return vec3<f32>(p.x,p.y,1.0); }
    default: { return vec3<f32>(-p.x,p.y,-1.0); }
  }
}
fn cubeDirection(uv:vec2<f32>) -> vec3<f32> { return rawCubeDirection(uv)*0.5; }
fn texelHeight(p: vec2<i32>, layer: i32) -> f32 {
  let size=vec2<i32>(textureDimensions(heights));
  return dot(textureLoad(heights,clamp(p,vec2<i32>(0),size-1),layer,0).rg,vec2<f32>(255.0,65280.0))*0.5-10000.0;
}
@compute @workgroup_size(8,8,1)
fn buildGradients(@builtin(global_invocation_id) id:vec3<u32>) {
  let dims=textureDimensions(gradientOutput);
  if (id.x>=dims.x || id.y>=dims.y || id.z>=textureNumLayers(gradientOutput)) { return; }
  let p=vec2<i32>(id.xy);let layer=i32(id.z);
  let du=texelHeight(p+vec2<i32>(1,0),layer)-texelHeight(p-vec2<i32>(1,0),layer);
  let dv=texelHeight(p+vec2<i32>(0,1),layer)-texelHeight(p-vec2<i32>(0,1),layer);
  textureStore(gradientOutput,p,layer,vec4<f32>(du,dv,0.0,0.0));
}
fn gradientAt(uv:vec2<f32>,layer:f32) -> vec2<f32> {
  return textureSampleLevel(gradients,linearSampler,uv,i32(layer),0.0).rg;
}
fn cachedNormal(uv:vec2<f32>,direction:vec3<f32>) -> vec3<f32> {
  let size=f32(textureDimensions(gradients).x);
  let step=vec2<f32>(1.0)/(abs(params.bestUV.zw)*size);
  var slope=vec2<f32>(0.0);
  if(params.record.w>=1.0) {
    slope=gradientAt(params.bestUV.xy+uv*params.bestUV.zw,params.record.y)*sign(params.bestUV.zw);
  } else {
    let parent=gradientAt(params.parentUV.xy+uv*params.parentUV.zw,params.record.z)*sign(params.parentUV.zw)*abs(params.parentUV.zw/params.bestUV.zw);
    slope=parent;
    if(params.record.w>0.0) {
      let fine=gradientAt(params.bestUV.xy+uv*params.bestUV.zw,params.record.y)*sign(params.bestUV.zw);
      slope=mix(parent,fine,params.record.w);
    }
  }
  let d=normalize(direction);
  var axisU=vec3<f32>(1.0,0.0,0.0);var axisV=vec3<f32>(0.0,1.0,0.0);
  switch i32(params.face.x) {
    case 0: {axisU=vec3<f32>(0.0,0.0,-1.0);}
    case 1: {axisU=vec3<f32>(0.0,0.0,1.0);}
    case 2: {axisV=vec3<f32>(0.0,0.0,-1.0);}
    case 3: {axisV=vec3<f32>(0.0,0.0,1.0);}
    case 5: {axisU=vec3<f32>(-1.0,0.0,0.0);}
    default: {}
  }
  let tangentU=(axisU-d*dot(d,axisU))/length(direction);
  let tangentV=(axisV-d*dot(d,axisV))/length(direction);
  let edgeU=tangentU*(2.0*params.limits.x*params.faceUV.z*step.x)+d*slope.x;
  let edgeV=tangentV*(2.0*params.limits.x*params.faceUV.w*step.y)+d*slope.y;
  return normalize(cross(edgeU,edgeV));
}
fn sampleUV(index:u32) -> vec2<f32> {
  let size=u32(params.record.x);
  return (vec2<f32>(f32(index%size),f32(index/size))+0.5)/f32(size);
}
@compute @workgroup_size(64)
fn directNormals(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.x>=arrayLength(&results)) {return;}
  let uv=sampleUV(id.x);
  let normal=surfaceNormal(heights,cubeDirection(uv),uv,params.record.yz,params.bestUV,params.parentUV,params.record.w,params.face.x,params.faceUV.zw,params.limits.x,1.0);
  results[id.x]=vec4<f32>(normal,1.0);
}
@compute @workgroup_size(64)
fn cachedNormals(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.x>=arrayLength(&results)) {return;}
  let uv=sampleUV(id.x);
  results[id.x]=vec4<f32>(cachedNormal(uv,cubeDirection(uv)),1.0);
}
fn sunlightAt(uv:vec2<f32>) -> f32 {
  let direction=cubeDirection(uv);
  let height=sampleSurfaceHeight(heights,direction,uv,params.record.yz,params.bestUV,params.parentUV,params.record.w,1.0);
  return terrainSunlight(heights,heightIndex,direction,height,params.solar.xyz,params.limits.x,params.limits.y,params.sampling.x,params.sampling.y,params.limits.w,params.limits.z,params.sampling.w,params.sampling.z,1.0,params.solar.w);
}
@compute @workgroup_size(8,8,1)
fn buildSunlight(@builtin(global_invocation_id) id:vec3<u32>) {
  let dims=textureDimensions(sunOutput);
  if(id.x>=dims.x || id.y>=dims.y) {return;}
  let uv=vec2<f32>(id.xy)/vec2<f32>(dims-1u);
  textureStore(sunOutput,vec2<i32>(id.xy),0,vec4<f32>(sunlightAt(uv),0.0,0.0,0.0));
}
@compute @workgroup_size(64)
fn directSunlight(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.x>=arrayLength(&results)) {return;}
  let size=u32(params.record.x);
  let uv=vec2<f32>(f32(id.x%size),f32(id.x/size))/f32(size-1u);
  results[id.x]=vec4<f32>(sunlightAt(uv));
}
@compute @workgroup_size(64)
fn cachedSunlight(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.x>=arrayLength(&results)) {return;}
  let size=u32(params.record.x);
  results[id.x]=vec4<f32>(textureLoad(sunCache,vec2<i32>(i32(id.x%size),i32(id.x/size)),0,0).r);
}

// Conservative integration candidate: preserve the existing height-blend stencil
// throughout a transition, and use cached gradients only for a settled tile.
@compute @workgroup_size(64)
fn hybridNormals(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.x>=arrayLength(&results)) {return;}
  let uv=sampleUV(id.x);
  var normal=vec3<f32>(0.0);
  if(params.record.w<1.0) {
    normal=surfaceNormal(heights,cubeDirection(uv),uv,params.record.yz,params.bestUV,params.parentUV,params.record.w,params.face.x,params.faceUV.zw,params.limits.x,1.0);
  } else { normal=cachedNormal(uv,cubeDirection(uv)); }
  results[id.x]=vec4<f32>(normal,1.0);
}
