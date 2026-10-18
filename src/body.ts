/** Spherical reference body. Coordinates are planetocentric, east-positive. */
export interface GlobeBody {
  name: string;
  radiusMeters: number;
}

export function validateBody(body: GlobeBody): void {
  if (
    !body ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    !Number.isFinite(body.radiusMeters) ||
    body.radiusMeters <= 0
  )
    throw new RangeError("A body requires a nonempty name and positive radiusMeters.");
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
