import * as THREE from "three/webgpu";
import { createSelectionView, VIEW } from "./tiles/lod.ts";
import { toSphere } from "./ellipsoid.ts";

const _sphereCamera = new THREE.Vector3(),
  _cameraQuaternion = new THREE.Quaternion(),
  _globeQuaternion = new THREE.Quaternion();

/**
 * The camera as tile selection sees it: in the globe's frame, against a sphere. Holds the
 * selection view and the camera's position, forward and clip transform in that frame.
 */
export function createCameraView({
  radius,
  flattening,
  segments,
  maxLevel,
  cellPixels,
}: {
  radius: number;
  flattening: number;
  segments: number;
  maxLevel: number;
  cellPixels: number;
}) {
  const view = createSelectionView();
  view[VIEW.Radius] = radius;
  view[VIEW.Segments] = segments;
  view[VIEW.MaxLevel] = maxLevel;
  view[VIEW.MaxCellPixels] = cellPixels;
  view[VIEW.Cull] = 1;
  const relativeCamera = new THREE.PerspectiveCamera(),
    frustum = new THREE.Frustum(),
    projectionView = new THREE.Matrix4(),
    forward = new THREE.Vector3(),
    position = new THREE.Vector3();
  return {
    view,
    /** Camera position in the globe's frame. */
    position,
    /** Camera forward in the globe's frame. */
    forward,
    /** Clip space from the globe's frame, rotation only. */
    projectionView,
    /** The height range the horizon test allows for; undefined is a smooth ellipsoid. */
    setHeights(heights?: { minMeters: number; maxMeters: number }) {
      // The horizon test needs a sphere inside the surface, so it allows for the flattening.
      view[VIEW.MinElevation] =
        (heights ? Math.min(0, heights.minMeters) : 0) - radius * flattening;
      view[VIEW.MaxElevation] = heights ? Math.max(0, heights.maxMeters) : 0;
    },
    update(
      globe: THREE.Object3D,
      camera: THREE.PerspectiveCamera,
      reversedDepth: boolean,
      bufferHeight: number,
    ) {
      camera.updateMatrixWorld(true);
      globe.updateMatrixWorld(true);
      // Selection runs in the globe's frame: camera position and rotation relative to it.
      globe.worldToLocal(camera.getWorldPosition(position));
      globe.getWorldQuaternion(_globeQuaternion).invert();
      relativeCamera.quaternion.multiplyQuaternions(
        _globeQuaternion,
        camera.getWorldQuaternion(_cameraQuaternion),
      );
      relativeCamera.projectionMatrix.copy(camera.projectionMatrix);
      relativeCamera.updateMatrixWorld(true);
      relativeCamera.getWorldDirection(forward);
      projectionView.multiplyMatrices(
        relativeCamera.projectionMatrix,
        relativeCamera.matrixWorldInverse,
      );
      frustum.setFromProjectionMatrix(projectionView, THREE.WebGPUCoordinateSystem, reversedDepth);
      // Selection sees the sphere, with the camera at its height over the matching point.
      // That is exact beneath the camera and drifts with distance, by less than this.
      toSphere(position, radius, flattening, _sphereCamera);
      const planeSlack = Math.min(
        radius * flattening,
        Math.max(0, _sphereCamera.length() - radius) * 0.02,
      );
      for (let i = 0; i < 6; i++) {
        const plane = frustum.planes[i];
        view.set(
          [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant + planeSlack],
          VIEW.Planes + i * 4,
        );
      }
      view[VIEW.CameraX] = _sphereCamera.x;
      view[VIEW.CameraY] = _sphereCamera.y;
      view[VIEW.CameraZ] = _sphereCamera.z;
      view[VIEW.ProjectionScale] =
        bufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    },
  };
}
export type CameraView = ReturnType<typeof createCameraView>;
