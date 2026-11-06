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
