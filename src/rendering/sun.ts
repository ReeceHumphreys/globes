export const DEFAULT_SUN_LONGITUDE_DEG = 90;
export const DEFAULT_SUN_LATITUDE_DEG = 0;

// +X is longitude 0, +Y is north, -Z is 90° east. The result is a unit vector.
export function defaultSunDirection(): [number, number, number] {
  return sunDirection(
    (DEFAULT_SUN_LONGITUDE_DEG * Math.PI) / 180,
    (DEFAULT_SUN_LATITUDE_DEG * Math.PI) / 180,
  );
}

export function sunDirection(longitudeRad: number, latitudeRad: number): [number, number, number] {
  const cosLat = Math.cos(latitudeRad);
  const x = cosLat * Math.cos(longitudeRad);
  const y = Math.sin(latitudeRad);
  const z = -cosLat * Math.sin(longitudeRad);
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}
