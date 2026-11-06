import assert from "node:assert/strict";
import test from "node:test";
import { fillPaths, readGeoJson, surfaceSegments, type Position } from "../src/geojson.ts";

const feature = (geometry: object, properties: object | null = {}) => ({
  type: "Feature",
  properties,
  geometry,
});

test("every GeoJSON type sorts into points, lines and polygons", () => {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ];
  const shapes = readGeoJson({
    type: "FeatureCollection",
    features: [
      feature({ type: "Point", coordinates: [10, 20, 500] }, { name: "A" }),
      feature({
        type: "MultiPoint",
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      }),
      feature({
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
      feature({
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
          ],
        ],
      }),
      feature({ type: "Polygon", coordinates: [ring, ring] }),
      feature({ type: "MultiPolygon", coordinates: [[ring], [ring]] }),
      feature({
        type: "GeometryCollection",
        geometries: [{ type: "Point", coordinates: [5, 6] }],
      }),
      { type: "Feature", properties: null, geometry: null },
    ],
  });
  assert.equal(shapes.points.length, 4);
  assert.deepEqual(shapes.points[0], { position: [10, 20, 500], properties: { name: "A" } });
  assert.equal(shapes.lines.length, 3);
  assert.equal(shapes.polygons.length, 3);
  assert.equal(shapes.polygons[0].length, 2, "the hole stays with its polygon");
});

test("malformed GeoJSON is rejected rather than drawn wrong", () => {
  assert.throws(() => readGeoJson({ type: "Point", coordinates: [200, 0] }), RangeError);
  assert.throws(() => readGeoJson({ type: "Point", coordinates: [0, 95] }), RangeError);
  assert.throws(() => readGeoJson({ type: "Point", coordinates: ["a", 0] }), RangeError);
  assert.throws(() => readGeoJson({ type: "Point", coordinates: [null, 0] }), RangeError);
  assert.throws(() => readGeoJson({ type: "Point", coordinates: ["5", 0] }), RangeError);
  assert.throws(() => readGeoJson({ type: "Point", coordinates: [0, 0, "5"] }), RangeError);
  assert.throws(() => readGeoJson({ type: "LineString", coordinates: 3 }), TypeError);
  assert.throws(() => readGeoJson({ type: "LineString", coordinates: [[0, 0]] }), TypeError);
  const open = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  assert.throws(() => readGeoJson({ type: "Polygon", coordinates: [open] }), TypeError);
  assert.throws(() => readGeoJson({ type: "Polygon", coordinates: [open.slice(0, 2)] }), TypeError);
  assert.throws(() => readGeoJson({ type: "Circle" }), TypeError);
  assert.throws(() => readGeoJson(null), TypeError);
});

test("segments are split so they follow the curve, on the ellipsoid", () => {
  const radius = 6378137,
    flattening = 1 / 298.257223563;
  const line = [
    [0, 0],
    [10, 0],
  ] as const;
  assert.equal(surfaceSegments([line], radius, 0).length / 6, 10);
  const pole = surfaceSegments(
    [
      [
        [0, 89.5],
        [0, 90],
      ],
    ],
    radius,
    flattening,
  );
  assert.ok(Math.abs(pole[4] - radius * (1 - flattening)) < 1);
  const equator = surfaceSegments([line], radius, flattening);
  assert.ok(Math.abs(Math.hypot(equator[0], equator[1], equator[2]) - radius) < 1);
});

test("empty coordinates mean no location, and extra position values are ignored", () => {
  for (const type of ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon"]) {
    const shapes = readGeoJson({ type, coordinates: [] });
    assert.equal(shapes.points.length, 0, type);
    assert.equal(surfaceSegments(shapes.lines, 1000, 0).length, 0, type);
  }
  assert.deepEqual(
    readGeoJson({ type: "Point", coordinates: [1, 2, 3, 4] }).points[0].position,
    [1, 2, 3],
  );
});

test("a line across the antimeridian takes the short way", () => {
  const segments = surfaceSegments(
    [
      [
        [179, 0],
        [-179, 0],
      ],
    ],
    1000,
    0,
  );
  assert.equal(segments.length / 6, 2);
  // Every point stays near longitude 180, which is -x here.
  for (let i = 0; i < segments.length; i += 3) assert.ok(segments[i] < -999);
});

test("a line runs along a cut at the antimeridian as written", () => {
  const band = [
    [-180, 80],
    [180, 80],
  ] as const;
  assert.equal(surfaceSegments([band], 1000, 0).length / 6, 360);
});

test("heights lift lines off the ellipsoid, as a ramp between positions", () => {
  const segments = surfaceSegments(
    [
      [
        [0, 0, 100],
        [1, 0, 300],
      ],
    ],
    1000,
    0,
  );
  assert.ok(Math.abs(Math.hypot(segments[0], segments[1], segments[2]) - 1100) < 1e-3);
  assert.ok(Math.abs(Math.hypot(segments[3], segments[4], segments[5]) - 1300) < 1e-3);
});

// What a canvas does with fillPaths: even-odd over every path together.
const filled = (paths: Position[][], longitude: number, latitude: number) => {
  let inside = false;
  for (const path of paths)
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1],
        [x1, y1] = path[i];
      if (y0 > latitude !== y1 > latitude) {
        const x = x0 + ((latitude - y0) / (y1 - y0)) * (x1 - x0);
        if (x > longitude) inside = !inside;
      }
    }
  return inside;
};

test("a fill across the antimeridian covers both edges of the map, and nothing between", () => {
  const paths = fillPaths([
    [
      [175, -5],
      [-175, -5],
      [-175, 5],
      [175, 5],
      [175, -5],
    ],
  ]);
  assert.ok(filled(paths, 178, 0));
  assert.ok(filled(paths, -178, 0));
  assert.ok(!filled(paths, 0, 0));
  assert.ok(!filled(paths, 178, 10));
});

test("a hole past the antimeridian still cuts its polygon", () => {
  const paths = fillPaths([
    [
      [170, -10],
      [-170, -10],
      [-170, 10],
      [170, 10],
      [170, -10],
    ],
    [
      [-178, -2],
      [-174, -2],
      [-174, 2],
      [-178, 2],
      [-178, -2],
    ],
  ]);
  assert.ok(!filled(paths, -176, 0));
  assert.ok(filled(paths, -172, 0));
  assert.ok(filled(paths, 175, 0));
});

test("a ring circling a pole fills the cap around it", () => {
  const paths = fillPaths([
    [
      [0, -80],
      [120, -80],
      [-120, -80],
      [0, -80],
    ],
  ]);
  for (const longitude of [-170, -50, 50, 170]) assert.ok(filled(paths, longitude, -85));
  assert.ok(!filled(paths, 50, -70));
  assert.ok(!filled(paths, 50, 85));
});

test("a ring along the map's edges fills the whole map", () => {
  const paths = fillPaths([
    [
      [-180, -90],
      [180, -90],
      [180, 90],
      [-180, 90],
      [-180, -90],
    ],
  ]);
  for (const longitude of [-170, 0, 170]) assert.ok(filled(paths, longitude, 45));
});
