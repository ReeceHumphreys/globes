import { worldToFace } from "./roots.ts";
export interface CoverageCap {
  latitudeDeg: number;
  longitudeDeg: number;
  radiusMeters: number;
  maxLevel: number;
}
export interface CoverageAddress {
  face: number;
  level: number;
  x: number;
  y: number;
}

function center(cap: CoverageCap): [number, number, number] {
  const lat = (cap.latitudeDeg * Math.PI) / 180,
    lon = (cap.longitudeDeg * Math.PI) / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
}
// Offline selection only. This mirrors RegionCoverage's conservative cube cap
// bounds; both tiers form one address set and share their source imagery.
export function planCoverage(
  radius: number,
  detail: CoverageCap,
  overview?: CoverageCap,
  minLevel = 1,
  limit = 20000,
): CoverageAddress[] {
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError("Invalid body radius");
  const result = new Map<string, CoverageAddress>();
  if (overview) {
    const a = center(detail),
      b = center(overview);
    if (
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * radius + detail.radiusMeters >
        overview.radiusMeters ||
      overview.maxLevel > detail.maxLevel
    )
      throw new Error("Overview must contain detail and use an equal or lower level.");
  }
  for (const cap of overview ? [detail, overview] : [detail]) {
    if (
      !Number.isFinite(cap.latitudeDeg) ||
      Math.abs(cap.latitudeDeg) > 90 ||
      !Number.isFinite(cap.longitudeDeg) ||
      Math.abs(cap.longitudeDeg) > 180 ||
      !Number.isFinite(cap.radiusMeters) ||
      cap.radiusMeters < 100 ||
      cap.radiusMeters > 100000 ||
      !Number.isInteger(cap.maxLevel) ||
      cap.maxLevel < 1 ||
      cap.maxLevel > 16
    )
      throw new Error("Invalid coverage cap");
    const d = center(cap),
      axis = d.map(Math.abs),
      major = Math.max(...axis),
      index = axis.indexOf(major),
      face = index === 0 ? (d[0] > 0 ? 0 : 1) : index === 1 ? (d[1] > 0 ? 2 : 3) : d[2] > 0 ? 4 : 5;
    const local = new Float64Array(3);
    worldToFace(face, ...d, local);
    const delta = 2 * Math.sin(cap.radiusMeters / radius / 2);
    const interval = (q: number) => {
      const p = [
        (q - delta) / (major - delta),
        (q + delta) / (major - delta),
        (q - delta) / (major + delta),
        (q + delta) / (major + delta),
      ];
      return [(Math.min(...p) + 1) / 2, (Math.max(...p) + 1) / 2];
    };
    const u = interval(local[0]),
      v = interval(local[1]);
    if (u[0] <= 0 || u[1] >= 1 || v[0] <= 0 || v[1] >= 1)
      throw new Error("Coverage crosses cube-face boundary");
    for (let level = minLevel; level <= cap.maxLevel; level++) {
      const n = 2 ** level;
      for (let y = Math.floor(v[0] * n); y <= Math.floor(v[1] * n); y++)
        for (let x = Math.floor(u[0] * n); x <= Math.floor(u[1] * n); x++) {
          result.set(`${face}/${level}/${x}/${y}`, { face, level, x, y });
          if (result.size > limit)
            throw new Error(
              "Region exceeds 20,000 tiles per layer; lower --max-level or --radius-meters before downloading.",
            );
        }
    }
  }
  return [...result.values()].sort(
    (a, b) => a.level - b.level || a.face - b.face || a.y - b.y || a.x - b.x,
  );
}
