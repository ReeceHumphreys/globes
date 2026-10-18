import { sampleHeight, type HeightField } from "./height-field.ts";

// Central difference on the sphere. East × north points outward; uphill tilts the normal back.
export function reliefNormal(
  field: HeightField,
  x: number,
  y: number,
  z: number,
  radius: number,
  enabled: boolean,
): [number, number, number] {
  const length = Math.hypot(x, y, z);
  const dx = x / length,
    dy = y / length,
    dz = z / length;
  if (!enabled) return [dx, dy, dz];
  const lonStep = (2 * Math.PI) / field.width;
  const latStep = Math.PI / field.height;
  const ax = Math.abs(dy) > 0.8 ? 1 : 0;
  const ay = Math.abs(dy) > 0.8 ? 0 : 1;
  let ex = ay * dz;
  let ey = -ax * dz;
  let ez = ax * dy - ay * dx;
  const eastLength = Math.hypot(ex, ey, ez);
  ex /= eastLength;
  ey /= eastLength;
  ez /= eastLength;
  const nx = dy * ez - dz * ey;
  const ny = dz * ex - dx * ez;
  const nz = dx * ey - dy * ex;
  const place = (ox: number, oy: number, oz: number, step: number) => {
    const px = dx + ox * step,
      py = dy + oy * step,
      pz = dz + oz * step;
    const scale = (radius + sampleHeight(field, px, py, pz)) / Math.hypot(px, py, pz);
    return [px * scale, py * scale, pz * scale];
  };
  const east = place(ex, ey, ez, lonStep);
  const west = place(ex, ey, ez, -lonStep);
  const north = place(nx, ny, nz, latStep);
  const south = place(nx, ny, nz, -latStep);
  const cx =
    (east[1] - west[1]) * (north[2] - south[2]) - (east[2] - west[2]) * (north[1] - south[1]);
  const cy =
    (east[2] - west[2]) * (north[0] - south[0]) - (east[0] - west[0]) * (north[2] - south[2]);
  const cz =
    (east[0] - west[0]) * (north[1] - south[1]) - (east[1] - west[1]) * (north[0] - south[0]);
  const normalLength = Math.hypot(cx, cy, cz);
  return [cx / normalLength, cy / normalLength, cz / normalLength];
}
