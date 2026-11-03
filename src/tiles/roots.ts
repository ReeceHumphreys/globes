// Face ids 0..5 are +X, -X, +Y, -Y, +Z, -Z.
export const FACE_COUNT = 6;
export const FACE_NAMES = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"] as const;

// PlaneGeometry faces +Z. Rotation around X then Y gives these orientations.
// Right, left, north, south, front, back in the initial camera view.
export const FACE_ROTATION_X = new Float32Array([0, 0, -Math.PI / 2, Math.PI / 2, 0, 0]);
export const FACE_ROTATION_Y = new Float32Array([Math.PI / 2, -Math.PI / 2, 0, 0, 0, Math.PI]);

// Face-local (u, v, w) after rotateX then rotateY. w is the outward axis.
// +X (w, v, -u), -X (-w, v, u), +Y (u, w, -v), -Y (u, -w, v), +Z (u, v, w), -Z (-u, v, -w).
export function faceToWorld(
  face: number,
  u: number,
  v: number,
  w: number,
  out: Float64Array,
  offset = 0,
): void {
  const o = offset;
  switch (face) {
    case 0: // +X
      out[o] = w;
      out[o + 1] = v;
      out[o + 2] = -u;
      break;
    case 1: // -X
      out[o] = -w;
      out[o + 1] = v;
      out[o + 2] = u;
      break;
    case 2: // +Y
      out[o] = u;
      out[o + 1] = w;
      out[o + 2] = -v;
      break;
    case 3: // -Y
      out[o] = u;
      out[o + 1] = -w;
      out[o + 2] = v;
      break;
    case 4: // +Z
      out[o] = u;
      out[o + 1] = v;
      out[o + 2] = w;
      break;
    case 5: // -Z
      out[o] = -u;
      out[o + 1] = v;
      out[o + 2] = -w;
      break;
  }
}

// Transpose of faceToWorld. A signed permutation is its own inverse once axes and signs swap.
export function worldToFace(
  face: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  offset = 0,
): void {
  const o = offset;
  switch (face) {
    case 0: // +X
      out[o] = -z;
      out[o + 1] = y;
      out[o + 2] = x;
      break;
    case 1: // -X
      out[o] = z;
      out[o + 1] = y;
      out[o + 2] = -x;
      break;
    case 2: // +Y
      out[o] = x;
      out[o + 1] = -z;
      out[o + 2] = y;
      break;
    case 3: // -Y
      out[o] = x;
      out[o + 1] = z;
      out[o + 2] = -y;
      break;
    case 4: // +Z
      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = z;
      break;
    case 5: // -Z
      out[o] = -x;
      out[o + 1] = y;
      out[o + 2] = -z;
      break;
  }
}

const facePointScratch = new Float64Array(3);
/** Dominant cube face of a nonzero direction, and its face UV in 0..1. */
export function facePoint(x: number, y: number, z: number): [number, number, number] {
  const ax = Math.abs(x),
    ay = Math.abs(y),
    az = Math.abs(z),
    face = ax >= ay && ax >= az ? (x >= 0 ? 0 : 1) : ay >= az ? (y >= 0 ? 2 : 3) : z >= 0 ? 4 : 5;
  worldToFace(face, x, y, z, facePointScratch);
  return [
    face,
    (facePointScratch[0] / facePointScratch[2] + 1) / 2,
    (facePointScratch[1] / facePointScratch[2] + 1) / 2,
  ];
}
