import { MathUtils, Vector3 } from "three/webgpu";

/** Unit direction of a geographic position, in east-positive degrees. */
export function geographicToDirection(
  latitudeDeg: number,
  longitudeDeg: number,
  target = new Vector3(),
): Vector3 {
  const lat = MathUtils.degToRad(latitudeDeg),
    lon = MathUtils.degToRad(longitudeDeg);
  return target.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
}
