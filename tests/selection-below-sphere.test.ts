import test from "node:test";
import assert from "node:assert/strict";
import { createSelectionView, VIEW } from "../src/tiles/lod.ts";
import { createTileBatch } from "../src/tiles/tile.ts";
import { selectAdaptiveTiles } from "../src/tiles/quadtree.ts";
import { PerspectiveCamera, Frustum, Matrix4, WebGPUCoordinateSystem } from "three/webgpu";

test("terrain-aware selection supports cameras below the reference sphere", () => {
  // A depression 2 km below the reference sphere; every tile reports the same conservative range.
  const minMeters = -2000,
    maxMeters = 2000,
    heights = {
      rangeForTile(_f: number, _l: number, _x: number, _y: number, out: Float64Array) {
        out[0] = minMeters;
        out[1] = maxMeters;
      },
    },
    r = 1737400;
  const camera = new PerspectiveCamera(75, 1.5, 0.1, r * 20);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.position.set(-(r + minMeters + 10), 0, 0);
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
  view[VIEW.MinElevation] = minMeters;
  view[VIEW.MaxElevation] = maxMeters;
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
