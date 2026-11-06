import { Vector3 } from "three/webgpu";
import { ellipsoidOffset } from "./ellipsoid.ts";
import { geographicToDirection } from "./geographic.ts";

/** Longitude and latitude in degrees, then any height in meters above the ellipsoid. */
export type Position = readonly [number, number, number?];
type Line = readonly Position[];

export interface GeoShapes {
  points: { position: Position; properties: Record<string, unknown> }[];
  lines: Line[];
  /** Each polygon is an outer ring followed by any holes. */
  polygons: Line[][];
}

const position = (value: unknown): Position => {
  // Parsers may ignore anything past the height.
  const [longitude, latitude, height] = (Array.isArray(value) ? value : []) as unknown[];
  if (
    typeof longitude !== "number" ||
    typeof latitude !== "number" ||
    !(Math.abs(longitude) <= 180) ||
    !(Math.abs(latitude) <= 90) ||
    !(height === undefined || Number.isFinite(height))
  )
    throw new RangeError(`Invalid GeoJSON position: ${JSON.stringify(value)}`);
  return height === undefined ? [longitude, latitude] : [longitude, latitude, height as number];
};
const line = (value: unknown): Line => {
  if (!Array.isArray(value) || value.length === 1) throw new TypeError("Invalid GeoJSON line");
  return value.map(position);
};
const ring = (value: unknown): Line => {
  const points = line(value);
  const first = points[0],
    last = points[points.length - 1];
  if (points.length < 4 || first.length !== last.length || first.some((n, i) => n !== last[i]))
    throw new TypeError("A GeoJSON ring needs four or more positions, and to end where it began");
  return points;
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
    const polygon = (rings: unknown) => shapes.polygons.push(list(rings).map(ring));
    switch (object?.type) {
      case "FeatureCollection":
        return list(object.features).forEach((feature) => visit(feature, {}));
      case "Feature":
        // A feature without a location is valid GeoJSON, and draws nothing.
        return object.geometry ? visit(object.geometry, object.properties ?? {}) : undefined;
      case "GeometryCollection":
        return list(object.geometries).forEach((geometry) => visit(geometry, properties));
      case "Point":
        // Empty coordinates are valid, and mean no location.
        return list(object.coordinates).length > 0 ? void point(object.coordinates) : undefined;
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

// RFC 7946 3.1.1: the line between two positions is the shortest, so a step of more than
// half the world crosses the antimeridian. A full 360 runs along a cut, or a pole, as written.
const eastward = (from: number, to: number) => {
  const step = to - from;
  return Math.abs(step) > 180 && Math.abs(step) < 360 ? step - Math.sign(step) * 360 : step;
};

// Longitudes run on past ±180 instead of jumping, and a ring circling a pole closes through it.
function flatRing(ring: Line): Position[] {
  let longitude = ring[0][0],
    latitudes = 0;
  const flat = ring.map(([next, latitude], i): Position => {
    if (i > 0) longitude += eastward(ring[i - 1][0], next);
    latitudes += latitude;
    return [longitude, latitude];
  });
  const start = flat[0][0];
  if (Math.abs(longitude - start) < 180) return flat;
  const pole = latitudes < 0 ? -90 : 90;
  return [...flat, [longitude, pole], [start, pole], flat[0]];
}

/**
 * The closed paths that paint a polygon on a map from -180 to 180. Fill them together,
 * even-odd: a hole may land in another world's copy of its polygon.
 */
export function fillPaths(rings: readonly Line[]): Position[][] {
  return rings
    .map(flatRing)
    .flatMap((ring) =>
      [-360, 0, 360].map((world) =>
        ring.map(([longitude, latitude]): Position => [longitude + world, latitude]),
      ),
    );
}

/** Pairs of xyz segment ends at each position's height, for line drawing. */
export function surfaceSegments(
  lines: readonly Line[],
  radius: number,
  flattening: number,
): Float32Array {
  const out: number[] = [];
  const write = (longitude: number, latitude: number, height: number) => {
    geographicToDirection(latitude, longitude, _normal);
    ellipsoidOffset(_normal, radius, flattening, _point).addScaledVector(_normal, radius + height);
    out.push(_point.x, _point.y, _point.z);
  };
  for (const points of lines)
    for (let i = 1; i < points.length; i++) {
      const [lon0, lat0, height0 = 0] = points[i - 1],
        [lon1, lat1, height1 = 0] = points[i];
      const east = eastward(lon0, lon1);
      const steps = Math.ceil(Math.max(Math.abs(east), Math.abs(lat1 - lat0)) / MAX_STEP_DEGREES);
      for (let step = 0; step < steps; step++)
        for (const end of [step / steps, (step + 1) / steps])
          write(lon0 + east * end, lat0 + (lat1 - lat0) * end, height0 + (height1 - height0) * end);
    }
  return new Float32Array(out);
}
