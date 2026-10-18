// GGX microfacet reflection, separable Smith visibility and Schlick Fresnel.
// Water IOR ~1.333 gives F0 ~0.0204. Roughness represents unresolved waves.
fn oceanRadiance(color: vec3<f32>, normal: vec3<f32>, view: vec3<f32>,
  sun: vec3<f32>, direct: vec3<f32>, indirect: vec3<f32>,
  sky: vec3<f32>, visibility: f32, roughness: f32
) -> vec3<f32> {
  let n = normalize(normal);
  let v = normalize(view);
  let l = normalize(sun);
  let nv = max(dot(n,v),0.0001);
  let nl = max(dot(n,l),0.0);
  let fresnelView = 0.0204 + 0.9796*pow(1.0-nv,5.0);
  let diffuse = color*(direct*nl*visibility+indirect)/3.14159265359;
  var result = diffuse*(1.0-fresnelView) + sky*fresnelView;
  if (nl > 0.0 && dot(n,v) > 0.0 && visibility > 0.0) {
    let halfVector = normalize(v+l);
    let nh = max(dot(n,halfVector),0.0);
    let vh = max(dot(v,halfVector),0.0);
    let alpha = max(0.04,roughness*roughness);
    let a2 = alpha*alpha;
    let denominator = nh*nh*(a2-1.0)+1.0;
    let distribution = a2/(3.14159265359*denominator*denominator);
    let gv = 2.0*nv/(nv+sqrt(a2+(1.0-a2)*nv*nv));
    let gl = 2.0*nl/(nl+sqrt(a2+(1.0-a2)*nl*nl));
    let fresnel = 0.0204+0.9796*pow(1.0-vh,5.0);
    result += direct*(fresnel*distribution*gv*gl/max(4.0*nv,0.0001))*visibility;
  }
  return max(result,vec3<f32>(0.0));
}
