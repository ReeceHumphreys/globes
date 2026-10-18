import test from "node:test";
import assert from "node:assert/strict";
import { sampleHeight, loadHeightField } from "../src/elevation/height-field.ts";
import { createHeightBounds, heightBoundsForCap } from "../src/elevation/bounds.ts";
import { createElevationTexture } from "../src/rendering/elevation-texture.ts";
import { createSelectionView, VIEW } from "../src/tiles/lod.ts";
import { createTileBatch } from "../src/tiles/tile.ts";
import { selectAdaptiveTiles } from "../src/tiles/quadtree.ts";
import { PerspectiveCamera, Frustum, Matrix4, WebGPUCoordinateSystem } from "three/webgpu";

function analytic() {
  const width = 128,
    height = 64,
    values = new Uint16Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const lat = (0.5 - (y + 0.5) / height) * Math.PI,
        lon = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const meters = 2000 * Math.cos(lat) * Math.cos(lon) + 500 * Math.sin(lat);
      values[y * width + x] = Math.round((meters + 10000) * 2);
    }
  values.fill(21000, 0, width);
  values.fill(19000, (height - 1) * width);
  return {
    width,
    height,
    values,
    minMeters: Math.min(...values) * 0.5 - 10000,
    maxMeters: Math.max(...values) * 0.5 - 10000,
  };
}

test("height sampling decodes signed meters, north/south and the longitude seam", () => {
  const f = analytic();
  assert.equal(sampleHeight(f, 0, 1, 0), 500);
  assert.equal(sampleHeight(f, 0, -1, 0), -500);
  assert.ok(Math.abs(sampleHeight(f, 1, 0, 0) - 2000) < 3);
  assert.ok(Math.abs(sampleHeight(f, -1, 0, 1e-8) - sampleHeight(f, -1, 0, -1e-8)) < 1e-5);
  assert.throws(() => sampleHeight(f, 0, 0, 0), /nonzero/);
  const texture = createElevationTexture(f);
  const bytes = texture.image.data;
  for (let i = 0; i < f.values.length; i++)
    assert.equal(bytes[i * 2] + bytes[i * 2 + 1] * 256, f.values[i]);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.flipY, false);
  texture.dispose();
});

test("min/max cap bounds contain interpolated samples, including poles and wrap", () => {
  const f = analytic(),
    bounds = createHeightBounds(f),
    range = new Float64Array(2);
  for (let k = 0; k < 100; k++) {
    const lat = -Math.PI / 2 + (Math.PI * k) / 99,
      lon = -Math.PI + k * 2.399963;
    const x = Math.cos(lat) * Math.cos(lon),
      y = Math.sin(lat),
      z = -Math.cos(lat) * Math.sin(lon);
    const angle = 0.001 + (k % 10) * 0.06,
      chord = 2 * Math.sin(angle / 2);
    heightBoundsForCap(bounds, x, y, z, chord, range);
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const a = lat + (dy * angle) / 4,
          b = lon + (dx * angle) / 4;
        if (Math.abs(a) > Math.PI / 2) continue;
        const sx = Math.cos(a) * Math.cos(b),
          sy = Math.sin(a),
          sz = -Math.cos(a) * Math.sin(b);
        if (x * sx + y * sy + z * sz < Math.cos(angle)) continue;
        const h = sampleHeight(f, sx, sy, sz);
        assert.ok(h >= range[0] - 1e-7 && h <= range[1] + 1e-7, `${h} outside ${range}`);
      }
  }
});

test("terrain-aware selection supports cameras below the reference sphere", () => {
  const f = analytic(),
    heights = createHeightBounds(f),
    r = 1737400;
  const camera = new PerspectiveCamera(75, 1.5, 0.1, r * 20);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.position.set(-(r + sampleHeight(f, -1, 0, 0) + 10), 0, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const relative = new PerspectiveCamera();
  relative.quaternion.copy(camera.quaternion);
  relative.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, relative.matrixWorldInverse),
    WebGPUCoordinateSystem,
  );
  const view = createSelectionView();
  view.set([camera.position.x, 0, 0, r, 800, 32, 12, 20, 1]);
  view[VIEW.MinElevation] = f.minMeters;
  view[VIEW.MaxElevation] = f.maxMeters;
  frustum.planes.forEach((p, i) =>
    view.set([p.normal.x, p.normal.y, p.normal.z, p.constant], VIEW.Planes + i * 4),
  );
  const output = createTileBatch(2048);
  selectAdaptiveTiles(output, view, heights);
  assert.ok(output.count > 0 && output.count <= 2048);
  assert.ok(Math.max(...output.level.subarray(0, output.count)) >= 10);
  let found = false;
  for (let i = 0; i < output.count; i++) {
    const n = 2 ** output.level[i];
    if (
      output.face[i] === 1 &&
      output.x[i] <= n / 2 &&
      output.x[i] + 1 >= n / 2 &&
      output.y[i] <= n / 2 &&
      output.y[i] + 1 >= n / 2
    )
      found = true;
  }
  assert.ok(found, "camera subpoint remains selected in a depression");
});

test("elevation loader rejects incomplete buffers and incompatible vertical datum", async () => {
  const previous = globalThis.fetch;
  const m = {
    version: 1,
    body: "Moon",
    radiusMeters: 1737400,
    width: 2,
    height: 2,
    format: "uint16-le",
    rowOrder: "north-to-south",
    longitude: "-180-to-180-east",
    pixelRegistration: "centers",
    scaleMeters: 0.5,
    offsetMeters: -10000,
    minMeters: 0,
    maxMeters: 0,
    data: "heights.u16",
    bytes: 8,
  };
  try {
    globalThis.fetch = async (url) =>
      new Response(String(url).endsWith("manifest.json") ? JSON.stringify(m) : new Uint8Array(2));
    await assert.rejects(loadHeightField("https://example.test/manifest.json"), /Incomplete/);
    m.offsetMeters = 0;
    await assert.rejects(loadHeightField("https://example.test/manifest.json"), /Unsupported/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("elevation downloads report progress and preserve explicit request cancellation", async () => {
  const previous = globalThis.fetch,
    controller = new AbortController(),
    progress = [],
    seen = [];
  const m = {
    version: 1,
    body: "Moon",
    radiusMeters: 1737400,
    width: 2,
    height: 2,
    format: "uint16-le",
    rowOrder: "north-to-south",
    longitude: "-180-to-180-east",
    pixelRegistration: "centers",
    scaleMeters: 0.5,
    offsetMeters: -10000,
    minMeters: 0,
    maxMeters: 0,
    data: "heights.u16",
    bytes: 8,
  };
  const bytes = new Uint8Array([32, 78, 32, 78, 32, 78, 32, 78]);
  try {
    globalThis.fetch = async (url, options) => {
      seen.push(options.signal);
      return String(url).endsWith("manifest.json")
        ? new Response(JSON.stringify(m))
        : new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(bytes.slice(0, 3));
                stream.enqueue(bytes.slice(3));
                stream.close();
              },
            }),
          );
    };
    const field = await loadHeightField("https://example.test/manifest.json", {
      signal: controller.signal,
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });
    assert.deepEqual(progress, [
      [3, 8],
      [8, 8],
    ]);
    assert.deepEqual(seen, [controller.signal, controller.signal]);
    assert.equal(sampleHeight(field, 1, 0, 0), 0);
  } finally {
    globalThis.fetch = previous;
  }
});
