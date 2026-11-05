import assert from "node:assert/strict";
import test from "node:test";
import { readGeoJson, surfaceSegments } from "../src/geojson.ts";

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
  assert.deepEqual(shapes.points[0], { position: [10, 20], properties: { name: "A" } });
  assert.equal(shapes.lines.length, 3);
  assert.equal(shapes.polygons.length, 3);
  assert.equal(shapes.polygons[0].length, 2, "the hole stays with its polygon");
});

test("malformed GeoJSON is rejected rather than drawn wrong", () => {
  assert.throws(() => readGeoJson({ type: "Point", coordinates: [200, 0] }), RangeError);
  assert.throws(() => readGeoJson({ type: "Point", coordinates: [0, 95] }), RangeError);
  assert.throws(() => readGeoJson({ type: "Point", coordinates: ["a", 0] }), RangeError);
  assert.throws(() => readGeoJson({ type: "LineString", coordinates: 3 }), TypeError);
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

test("a jump across the antimeridian leaves a gap, not a line around the world", () => {
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
  assert.equal(segments.length, 0);
});
