import { Vector3 } from "three/webgpu";
import { ellipsoidOffset } from "./ellipsoid.ts";
import { geographicToDirection } from "./geographic.ts";

/** Longitude, then latitude, in degrees: GeoJSON's order. */
export type Position = readonly [number, number];
type Line = readonly Position[];

export interface GeoShapes {
  points: { position: Position; properties: Record<string, unknown> }[];
  lines: Line[];
  /** Each polygon is an outer ring followed by any holes. */
  polygons: Line[][];
}

const position = (value: unknown): Position => {
  const [longitude, latitude] = Array.isArray(value) ? value : [];
  if (!(Math.abs(longitude) <= 180) || !(Math.abs(latitude) <= 90))
    throw new RangeError(`Invalid GeoJSON position: ${JSON.stringify(value)}`);
  return [longitude, latitude];
};
const line = (value: unknown): Line => {
  if (!Array.isArray(value)) throw new TypeError("Invalid GeoJSON line");
  return value.map(position);
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new TypeError("Invalid GeoJSON coordinates");
  return value;
};

/** Sorts any GeoJSON object into points, lines and polygons, rejecting what is malformed. */
export function readGeoJson(data: unknown): GeoShapes {
  const shapes: GeoShapes = { points: [], lines: [], polygons: [] };
  const visit = (value: unknown, properties: Record<string, unknown>): void => {
    const object = value as {
      type?: string;
      coordinates?: unknown;
      geometry?: unknown;
      geometries?: unknown;
      features?: unknown;
      properties?: Record<string, unknown> | null;
    } | null;
    const point = (at: unknown) => shapes.points.push({ position: position(at), properties });
    const polygon = (rings: unknown) => shapes.polygons.push(list(rings).map(line));
    switch (object?.type) {
      case "FeatureCollection":
        return list(object.features).forEach((feature) => visit(feature, {}));
      case "Feature":
        // A feature without a location is valid GeoJSON, and draws nothing.
        return object.geometry ? visit(object.geometry, object.properties ?? {}) : undefined;
      case "GeometryCollection":
        return list(object.geometries).forEach((geometry) => visit(geometry, properties));
      case "Point":
        return void point(object.coordinates);
      case "MultiPoint":
        return list(object.coordinates).forEach(point);
      case "LineString":
        return void shapes.lines.push(line(object.coordinates));
      case "MultiLineString":
        return list(object.coordinates).forEach((part) => shapes.lines.push(line(part)));
      case "Polygon":
        return void polygon(object.coordinates);
      case "MultiPolygon":
        return list(object.coordinates).forEach(polygon);
      default:
        throw new TypeError(`Unknown GeoJSON type: ${object?.type}`);
    }
  };
  visit(data, {});
  return shapes;
}

// A straight chord between far-apart points would cut under the surface.
const MAX_STEP_DEGREES = 1;
const _normal = new Vector3(),
  _point = new Vector3();

/** Pairs of xyz segment ends on the reference surface, for line drawing. */
export function surfaceSegments(
  lines: readonly Line[],
  radius: number,
  flattening: number,
): Float32Array {
  const out: number[] = [];
  const write = (longitude: number, latitude: number) => {
    geographicToDirection(latitude, longitude, _normal);
    ellipsoidOffset(_normal, radius, flattening, _point).addScaledVector(_normal, radius);
    out.push(_point.x, _point.y, _point.z);
  };
  for (const points of lines)
    for (let i = 1; i < points.length; i++) {
      const [lon0, lat0] = points[i - 1],
        [lon1, lat1] = points[i];
      // shortcut: a jump across the antimeridian is left as a gap, as RFC 7946 asks data
      // to be cut there. Upgrade if uncut data needs drawing.
      if (Math.abs(lon1 - lon0) > 180) continue;
      const steps = Math.ceil(
        Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0)) / MAX_STEP_DEGREES,
      );
      for (let step = 0; step < steps; step++)
        for (const end of [step / steps, (step + 1) / steps])
          write(lon0 + (lon1 - lon0) * end, lat0 + (lat1 - lat0) * end);
    }
  return new Float32Array(out);
}
