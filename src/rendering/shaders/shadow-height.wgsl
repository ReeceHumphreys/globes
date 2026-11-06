// Address the same resident height array as terrain, across all six cube faces.
// Unloaded finer regions fall back to resident parents, never clamped tile edges.
// The index walk only records which node it keeps. The height array, the large
// fetch, is read afterwards for that node and for its parent while the node fades in.
fn shadowHeight(heightTiles: texture_2d_array<f32>, indexMap: texture_2d<f32>, direction: vec3<f32>, coreSize: f32, gutter: f32, maxLevel: f32) -> f32 {
  let onFace = facePoint(direction);
  let face = i32(onFace.x);
  let uv = clamp(onFace.yz, vec2<f32>(0.0), vec2<f32>(0.99999994));
  let dims=textureDimensions(indexMap);
  let imageSize=f32(textureDimensions(heightTiles).x);
  var node=face;
  var local=uv;
  var slot=0.0;
  var parentSlot=0.0;
  var slotUV=vec2<f32>(0.0);
  var parentUV=vec2<f32>(0.0);
  var fade=1.0;
  var kept=false;
  var keptParent=false;
  // Supported source depth is at most 20. The lookup is bounded independently
  // of terrain mesh subdivision and uses nearest textureLoad metadata reads.
  for(var level=0;level<=20;level++) {
    let pixel=u32(node)*2u;
    let children=textureLoad(indexMap,vec2<i32>(i32(pixel%dims.x),i32(pixel/dims.x)),0);
    let value=textureLoad(indexMap,vec2<i32>(i32((pixel+1u)%dims.x),i32((pixel+1u)/dims.x)),0);
    if(value.x>0.5) {
      if(kept && fade<1.0) { break; }
      if(kept) { parentSlot=slot; parentUV=slotUV; keptParent=true; }
      slot=value.x;
      fade=value.y;
      slotUV=(vec2<f32>(gutter)+vec2<f32>(local.x,1.0-local.y)*coreSize)/imageSize;
      kept=true;
    }
    if(f32(level)>=maxLevel) { break; }
    let quadrant=vec2<i32>(min(floor(local*2.0),vec2<f32>(1.0)));
    let child=children[quadrant.x+2*quadrant.y];
    if(child<0.0) { break; }
    node=i32(child);
    local=local*2.0-vec2<f32>(quadrant);
  }
  if(!kept) { return 0.0; }
  let fine=sampleHeightLayer(heightTiles,slotUV,slot);
  if(fade>=1.0) { return fine; }
  // A first resident node with no coarser parent fades in from the zero-meter sphere.
  if(!keptParent) { return fine*fade; }
  return mix(sampleHeightLayer(heightTiles,parentUV,parentSlot),fine,fade);
}
