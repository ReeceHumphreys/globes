import test from "node:test";
import assert from "node:assert/strict";
import {
  PerspectiveCamera,
  Frustum,
  Matrix4,
  Vector3,
  Ray,
  Sphere,
  WebGPUCoordinateSystem,
} from "three/webgpu";
import { createSelectionView, VIEW } from "../src/tiles/lod.ts";
import { createTileBatch } from "../src/tiles/tile.ts";
import { selectAdaptiveTiles } from "../src/tiles/quadtree.ts";
import { createTileInstances, writeTileInstances } from "../src/rendering/tile-instances.ts";

const radius = 1737400;
function query(position) {
  const camera = new PerspectiveCamera(75, 1.5, 0.1, radius * 20);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.position.copy(position);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const relative = new PerspectiveCamera();
  relative.quaternion.copy(camera.quaternion);
  relative.updateMatrixWorld();
  const f = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, relative.matrixWorldInverse),
    WebGPUCoordinateSystem,
  );
  const view = createSelectionView();
  view.set([
    position.x,
    position.y,
    position.z,
    radius,
    800 / (2 * Math.tan((75 * Math.PI) / 360)),
    32,
    12,
    20,
    1,
  ]);
  f.planes.forEach((p, i) =>
    view.set([p.normal.x, p.normal.y, p.normal.z, p.constant], VIEW.Planes + i * 4),
  );
  return { camera, view };
}
function address(point) {
  const { x, y, z } = point,
    ax = Math.abs(x),
    ay = Math.abs(y),
    az = Math.abs(z);
  let face, u, v, w;
  if (ax >= ay && ax >= az) {
    face = x > 0 ? 0 : 1;
    w = ax;
    u = x > 0 ? -z : z;
    v = y;
  } else if (ay >= az) {
    face = y > 0 ? 2 : 3;
    w = ay;
    u = x;
    v = y > 0 ? -z : z;
  } else {
    face = z > 0 ? 4 : 5;
    w = az;
    u = z > 0 ? x : -x;
    v = y;
  }
  return [face, (u / w + 1) / 2, (v / w + 1) / 2];
}

test("culling reduces surface workload and preserves sampled visible coverage", () => {
  const tiles = createTileBatch(2048);
  for (const direction of [
    [0, 0, 1],
    [1, 0, 0],
    [1, 1, 1],
    [1, 0, 1],
  ]) {
    for (const altitude of [10, 10000, 2 * radius]) {
      const position = new Vector3(...direction).normalize().multiplyScalar(radius + altitude);
      const { camera, view } = query(position);
      view[VIEW.Cull] = 0;
      selectAdaptiveTiles(tiles, view);
      const fullCount = tiles.count;
      view[VIEW.Cull] = 1;
      selectAdaptiveTiles(tiles, view);
      assert.ok(tiles.count <= fullCount);
      if (altitude === 10) assert.ok(tiles.count < fullCount / 5);
      if (altitude === 10) assert.ok(tiles.count < 100, `surface count ${tiles.count}`);
      for (let y = -0.9; y <= 0.9; y += 0.3)
        for (let x = -0.9; x <= 0.9; x += 0.3) {
          const d = new Vector3(x, y, 0.5).unproject(camera).sub(position).normalize();
          const p = new Ray(position, d).intersectSphere(
            new Sphere(new Vector3(), radius),
            new Vector3(),
          );
          if (!p) continue;
          const [face, u, v] = address(p);
          let found = false;
          for (let i = 0; i < tiles.count; i++) {
            const n = 2 ** tiles.level[i];
            if (
              tiles.face[i] === face &&
              u * n >= tiles.x[i] - 1e-7 &&
              u * n <= tiles.x[i] + 1 + 1e-7 &&
              v * n >= tiles.y[i] - 1e-7 &&
              v * n <= tiles.y[i] + 1 + 1e-7
            )
              found = true;
          }
          assert.ok(
            found,
            `missing visible sample: altitude ${altitude}, direction ${direction}, screen ${x},${y}`,
          );
        }
    }
  }
});

test("camera-relative anchors retain centimeter offsets at lunar coordinates", () => {
  const tiles = createTileBatch(6);
  tiles.count = 1;
  tiles.face[0] = 4;
  tiles.level[0] = 20;
  tiles.x[0] = 2 ** 19;
  tiles.y[0] = 2 ** 19;
  const output = createTileInstances(6);
  const origin = [0.123456, 0.345678, radius + 10.012345];
  writeTileInstances(tiles, output, radius, ...origin);
  const size = radius / 2 ** 20,
    u = size / 2,
    v = size / 2,
    w = radius / 2;
  const scale = radius / Math.hypot(u, v, w);
  const expected = [u * scale - origin[0], v * scale - origin[1], w * scale - origin[2]];
  expected.forEach((p, i) => assert.ok(Math.abs(output.anchors[i] - p) < 0.00001));
});

test("reversed depth keeps a 10 m surface inside the selection frustum", () => {
  const altitude = 10;
  const camera = new PerspectiveCamera(75, 1.5, 0.2, radius * 3 + altitude);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  (camera as unknown as { _reversedDepth: boolean })._reversedDepth = true;
  camera.position.set(0, 0, radius + altitude);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const relative = new PerspectiveCamera();
  relative.quaternion.copy(camera.quaternion);
  relative.projectionMatrix.copy(camera.projectionMatrix);
  relative.updateMatrixWorld();
  const projectionView = new Matrix4().multiplyMatrices(
    relative.projectionMatrix,
    relative.matrixWorldInverse,
  );
  const frustum = new Frustum().setFromProjectionMatrix(
    projectionView,
    WebGPUCoordinateSystem,
    camera.reversedDepth,
  );
  const surface = new Vector3(0, 0, -altitude);
  assert.equal(frustum.containsPoint(surface), true);
  assert.equal(frustum.containsPoint(new Vector3(0, 0, -0.05)), false);
  assert.equal(frustum.containsPoint(new Vector3(0, 0, 1)), false);
  assert.equal(frustum.containsPoint(new Vector3(0, 0, -radius * 4)), false);
  const view = createSelectionView();
  view[VIEW.CameraZ] = radius + altitude;
  view[VIEW.Radius] = radius;
  view[VIEW.ProjectionScale] = 800 / (2 * Math.tan((75 * Math.PI) / 360));
  view[VIEW.Segments] = 32;
  view[VIEW.MaxCellPixels] = 12;
  view[VIEW.MaxLevel] = 20;
  view[VIEW.Cull] = 1;
  frustum.planes.forEach((plane, i) =>
    view.set([plane.normal.x, plane.normal.y, plane.normal.z, plane.constant], VIEW.Planes + i * 4),
  );
  const tiles = createTileBatch(2048);
  selectAdaptiveTiles(tiles, view);
  assert.ok(tiles.count > 0 && tiles.count < 100, `tiles ${tiles.count}`);
});
