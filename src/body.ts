/** Spherical reference body. Coordinates are planetocentric, east-positive. */
export interface GlobeBody {
  name: string;
  radiusMeters: number;
}

export function matchesBody(
  value: { body?: unknown; radiusMeters?: unknown },
  expected?: GlobeBody,
): boolean {
  return (
    typeof value.body === "string" &&
    value.body.trim().length > 0 &&
    typeof value.radiusMeters === "number" &&
    Number.isFinite(value.radiusMeters) &&
    value.radiusMeters > 0 &&
    (!expected ||
      (value.body === expected.name && Math.abs(value.radiusMeters - expected.radiusMeters) < 0.01))
  );
}
