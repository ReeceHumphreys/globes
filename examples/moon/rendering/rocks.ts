import type { CodeNode, Node, PerspectiveCamera } from "three/webgpu";
import {
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardNodeMaterial,
  Vector3,
} from "three/webgpu";
import { attribute, positionGeometry, transformNormalToView, wgslFn } from "three/tsl";
import type { TiledGlobe } from "tiled-globe";

// Drawn only near the surface. The shader grows each rock from its seed;
// this file only decides which seeds exist and where they sit.
export const ROCK_SHOW_ALTITUDE_M = 80;
export const ROCK_RANGE_M = 160;
export const ROCK_CELL_M = 16;
export const ROCK_CAPACITY = 192;
// rockRadius() in the shader stays within 0.74..1.06, so this keeps every
// vertex under the ground and the crown above it.
export const ROCK_BURY = 0.45;

const RADIUS_SHADER = /* wgsl */ `
fn rockRadius(dir: vec3<f32>, seed: f32) -> f32 {
  let p = dir * 3.1 + vec3<f32>(seed, seed * 1.37, seed * 0.71);
  let a = sin(dot(p, vec3<f32>(1.7, 2.3, 0.9)));
  let b = sin(dot(p, vec3<f32>(4.1, -2.4, 5.2)));
  let c = sin(dot(p, vec3<f32>(-6.3, 3.7, 2.8)));
  let n = a * 0.55 + b * 0.30 + c * 0.15;
  return mix(0.74, 1.06, n * 0.5 + 0.5);
}
`;

const POSITION_SHADER = /* wgsl */ `
fn rockPosition(geometryPos: vec3<f32>, center: vec3<f32>, axisX: vec3<f32>, axisY: vec3<f32>, axisZ: vec3<f32>, seed: f32) -> vec3<f32> {
  let dir = normalize(geometryPos);
  let local = dir * rockRadius(dir, seed);
  return center + axisX * local.x + axisY * local.y + axisZ * local.z;
}
`;

// Finite difference of the radius field. For a unit sphere this cross product
// points outward: dir +X with helper axis +Y yields normal +X.
const NORMAL_SHADER = /* wgsl */ `
fn rockNormal(geometryPos: vec3<f32>, axisX: vec3<f32>, axisY: vec3<f32>, axisZ: vec3<f32>, seed: f32) -> vec3<f32> {
  let dir = normalize(geometryPos);
  let e = 0.15;
  let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(dir.y) > 0.85);
  let t = normalize(cross(helper, dir));
  let b = cross(dir, t);
  let h = rockRadius(dir, seed);
  let ha = rockRadius(normalize(dir + t * e), seed);
  let hb = rockRadius(normalize(dir + b * e), seed);
  let da = t * h + dir * ((ha - h) / e);
  let db = b * h + dir * ((hb - h) / e);
  let n = normalize(cross(da, db));
  return normalize(axisX * n.x + axisY * n.y + axisZ * n.z);
}
`;

const ALBEDO_SHADER = /* wgsl */ `
fn rockAlbedo(seed: f32) -> vec3<f32> {
  let n = sin(seed * 12.9898) * 0.5 + 0.5;
  return mix(vec3<f32>(0.10, 0.095, 0.09), vec3<f32>(0.20, 0.19, 0.17), n);
}
`;

function mixHash(ix: number, iy: number, iz: number, salt: number): number {
  let n =
    Math.imul(ix, 374761393) ^
    Math.imul(iy, 668265263) ^
    Math.imul(iz, 1274126177) ^
    Math.imul(salt, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// Stable tangent. world +Y × up, and world +X × up when up is nearly north or south.
function tangent(
  dx: number,
  dy: number,
  dz: number,
): [number, number, number, number, number, number] {
  let ex = dz,
    ey = 0,
    ez = -dx;
  let el = Math.hypot(ex, ey, ez);
  if (el < 1e-8) {
    ex = 0;
    ey = -dz;
    ez = dy;
    el = Math.hypot(ex, ey, ez);
  }
  ex /= el;
  ey /= el;
  ez /= el;
  // east × up, so (east, up, side) stays right-handed.
  return [ex, ey, ez, ey * dz - ez * dy, ez * dx - ex * dz, ex * dy - ey * dx];
}

function writeAxes(
  dx: number,
  dy: number,
  dz: number,
  yaw: number,
  scale: number,
  axes: Float32Array,
  offset: number,
): void {
  const [ex, ey, ez, sx, sy, sz] = tangent(dx, dy, dz);
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  axes[offset] = (ex * c + sx * s) * scale;
  axes[offset + 1] = (ey * c + sy * s) * scale;
  axes[offset + 2] = (ez * c + sz * s) * scale;
  axes[offset + 3] = dx * scale;
  axes[offset + 4] = dy * scale;
  axes[offset + 5] = dz * scale;
  axes[offset + 6] = (-ex * s + sx * c) * scale;
  axes[offset + 7] = (-ey * s + sy * c) * scale;
  axes[offset + 8] = (-ez * s + sz * c) * scale;
}

/**
 * Fill camera-relative rock instances on a stable meter lattice.
 * Returns how many were written. Above {@link ROCK_SHOW_ALTITUDE_M} that is zero.
 */
export function scatterRocks(
  cameraX: number,
  cameraY: number,
  cameraZ: number,
  radius: number,
  sampleHeight: (x: number, y: number, z: number) => number,
  centers: Float32Array,
  axes: Float32Array,
  seeds: Float32Array,
): number {
  const capacity = Math.min(seeds.length, centers.length / 3, axes.length / 9, ROCK_CAPACITY);
  const camLen = Math.hypot(cameraX, cameraY, cameraZ);
  if (!(camLen > 0) || !(radius > 0) || capacity < 1) return 0;
  const altitude = camLen - radius - sampleHeight(cameraX, cameraY, cameraZ);
  if (!(altitude <= ROCK_SHOW_ALTITUDE_M)) return 0;

  const inv = 1 / camLen;
  const [ex, ey, ez, nx, ny, nz] = tangent(cameraX * inv, cameraY * inv, cameraZ * inv);
  const reach = ROCK_RANGE_M + ROCK_CELL_M;
  const steps = Math.ceil(reach / ROCK_CELL_M);
  const seen = new Set<string>();
  const rangeSq = ROCK_RANGE_M * ROCK_RANGE_M;
  let count = 0;

  for (let j = -steps; j <= steps && count < capacity; j++) {
    for (let i = -steps; i <= steps && count < capacity; i++) {
      if (i * i + j * j > steps * steps) continue;
      const stepX = ex * (i * ROCK_CELL_M) + nx * (j * ROCK_CELL_M);
      const stepY = ey * (i * ROCK_CELL_M) + ny * (j * ROCK_CELL_M);
      const stepZ = ez * (i * ROCK_CELL_M) + nz * (j * ROCK_CELL_M);
      const px = cameraX * inv * radius + stepX;
      const py = cameraY * inv * radius + stepY;
      const pz = cameraZ * inv * radius + stepZ;
      const plen = Math.hypot(px, py, pz);
      if (!(plen > 0)) continue;
      const ix = Math.floor(((px / plen) * radius) / ROCK_CELL_M);
      const iy = Math.floor(((py / plen) * radius) / ROCK_CELL_M);
      const iz = Math.floor(((pz / plen) * radius) / ROCK_CELL_M);
      const key = ix + ":" + iy + ":" + iz;
      if (seen.has(key)) continue;
      seen.add(key);
      if (mixHash(ix, iy, iz, 1) > 0.4) continue;

      const cx = (ix + 0.5) * ROCK_CELL_M;
      const cy = (iy + 0.5) * ROCK_CELL_M;
      const cz = (iz + 0.5) * ROCK_CELL_M;
      const clen = Math.hypot(cx, cy, cz);
      if (!(clen > 0)) continue;
      const [tx, ty, tz, ux, uy, uz] = tangent(cx / clen, cy / clen, cz / clen);
      const jx = (mixHash(ix, iy, iz, 3) - 0.5) * ROCK_CELL_M * 0.65;
      const jz = (mixHash(ix, iy, iz, 4) - 0.5) * ROCK_CELL_M * 0.65;
      const qx = cx + tx * jx + ux * jz;
      const qy = cy + ty * jx + uy * jz;
      const qz = cz + tz * jx + uz * jz;
      const qlen = Math.hypot(qx, qy, qz);
      if (!(qlen > 0)) continue;
      const dx = qx / qlen,
        dy = qy / qlen,
        dz = qz / qlen;
      const roll = mixHash(ix, iy, iz, 2);
      const scale = 0.4 + roll * roll * 1.6;
      const h = sampleHeight(dx, dy, dz);
      const placed = radius + h + scale * ROCK_BURY;
      const rx = dx * placed - cameraX;
      const ry = dy * placed - cameraY;
      const rz = dz * placed - cameraZ;
      if (rx * rx + ry * ry + rz * rz > rangeSq) continue;

      const o = count * 3;
      centers[o] = rx;
      centers[o + 1] = ry;
      centers[o + 2] = rz;
      writeAxes(dx, dy, dz, mixHash(ix, iy, iz, 5) * Math.PI * 2, scale, axes, count * 9);
      seeds[count] = mixHash(ix, iy, iz, 6) * Math.PI * 2;
      count++;
    }
  }
  return count;
}

function rockMaterial(): MeshStandardNodeMaterial {
  const include = (fn: ReturnType<typeof wgslFn>) => fn as unknown as CodeNode;
  const radiusFn = wgslFn(RADIUS_SHADER);
  const placed = {
    geometryPos: positionGeometry,
    center: attribute("center", "vec3"),
    axisX: attribute("axisX", "vec3"),
    axisY: attribute("axisY", "vec3"),
    axisZ: attribute("axisZ", "vec3"),
    seed: attribute("seed", "float"),
  };
  const material = new MeshStandardNodeMaterial({ roughness: 0.96, metalness: 0 });
  material.positionNode = wgslFn(POSITION_SHADER, [include(radiusFn)])(placed);
  material.normalNode = transformNormalToView(wgslFn(NORMAL_SHADER, [include(radiusFn)])(placed));
  material.colorNode = wgslFn(ALBEDO_SHADER)({ seed: placed.seed }) as Node<"vec3">;
  return material;
}

function instanced(name: string, itemSize: number): InstancedBufferAttribute {
  const attribute = new InstancedBufferAttribute(
    new Float32Array(ROCK_CAPACITY * itemSize),
    itemSize,
  );
  attribute.name = name;
  attribute.setUsage(DynamicDrawUsage);
  return attribute;
}

const _camera = new Vector3(),
  _direction = new Vector3();

/** Instanced rocks near the camera. Add to the Moon globe and call `update` each frame. */
export class SurfaceRocks extends Group {
  readonly #mesh: InstancedMesh;
  readonly #attributes: Record<
    "center" | "axisX" | "axisY" | "axisZ" | "seed",
    InstancedBufferAttribute
  >;
  readonly #axes = new Float32Array(ROCK_CAPACITY * 9);

  constructor() {
    super();
    // shortcut: rocks can intersect a lunar module, and they pop in at 80 m. Split them from the lander, or fade the gate, if either shows.
    this.name = "Surface rocks (camera relative)";
    const geometry = new IcosahedronGeometry(1, 2);
    this.#attributes = {
      center: instanced("center", 3),
      axisX: instanced("axisX", 3),
      axisY: instanced("axisY", 3),
      axisZ: instanced("axisZ", 3),
      seed: instanced("seed", 1),
    };
    for (const [name, attribute] of Object.entries(this.#attributes))
      geometry.setAttribute(name, attribute);
    const mesh = (this.#mesh = new InstancedMesh(geometry, rockMaterial(), ROCK_CAPACITY));
    mesh.name = "rocks";
    mesh.count = 0;
    mesh.frustumCulled = false;
    // The shader places each rock. An identity instance matrix keeps that position
    // whether the instance transform is applied before or after positionNode.
    const matrices = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < ROCK_CAPACITY; i++) {
      const o = i * 16;
      matrices[o] = matrices[o + 5] = matrices[o + 10] = matrices[o + 15] = 1;
    }
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    this.add(mesh);
  }

  /** Scatter rocks around the camera on the globe's terrain. */
  update(camera: PerspectiveCamera, globe: TiledGlobe): void {
    globe.worldToLocal(camera.getWorldPosition(_camera));
    // Rock vertices are camera-relative, so float32 stays exact next to the viewer.
    this.position.copy(_camera);
    const { center, axisX, axisY, axisZ, seed } = this.#attributes;
    const count = scatterRocks(
      _camera.x,
      _camera.y,
      _camera.z,
      globe.radius,
      (x, y, z) => globe.heightAt(_direction.set(x, y, z)),
      center.array as Float32Array,
      this.#axes,
      seed.array as Float32Array,
    );
    for (let i = 0; i < count; i++) {
      const o = i * 9;
      (axisX.array as Float32Array).set(this.#axes.subarray(o, o + 3), i * 3);
      (axisY.array as Float32Array).set(this.#axes.subarray(o + 3, o + 6), i * 3);
      (axisZ.array as Float32Array).set(this.#axes.subarray(o + 6, o + 9), i * 3);
    }
    this.#mesh.count = count;
    this.#mesh.visible = count > 0;
    for (const attribute of Object.values(this.#attributes)) attribute.needsUpdate = true;
  }

  dispose(): void {
    this.#mesh.geometry.dispose();
    (this.#mesh.material as MeshStandardNodeMaterial).dispose();
    this.removeFromParent();
  }
}
