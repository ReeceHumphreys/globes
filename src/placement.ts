import * as THREE from "three/webgpu";
import { geographicToDirection } from "./geographic.ts";
import type { GlobeAnchor } from "./globe-anchor.ts";
import type { GlobeLabel } from "./globe-label.ts";

/** What placement needs from a globe. */
export interface PlacementGlobe extends THREE.Object3D {
  heightAt(direction: THREE.Vector3): number;
  positionAt(
    latitude: number,
    longitude: number,
    altitude: number,
    target: THREE.Vector3,
  ): THREE.Vector3;
}

const _point = new THREE.Vector3(),
  _toward = new THREE.Vector3(),
  _east = new THREE.Vector3(),
  _up = new THREE.Vector3(),
  _south = new THREE.Vector3(),
  _basis = new THREE.Matrix4();

/**
 * Put the globe's anchors and labels on the terrain, and hide labels behind the horizon
 * or the camera. `camera` and `forward` are in the globe's frame. A hidden branch hides
 * its labels, so only visible branches are walked.
 */
export function placeChildren(
  globe: PlacementGlobe,
  camera: THREE.Vector3,
  forward: THREE.Vector3,
  object: THREE.Object3D = globe,
): void {
  for (const child of object.children) {
    if ((child as GlobeAnchor).isGlobeAnchor) placeAnchor(globe, child as GlobeAnchor);
    else if ((child as GlobeLabel).isGlobeLabel) {
      const label = child as GlobeLabel;
      const { latitude, longitude, altitude } = label;
      const ground =
        label.altitudeReference === "ellipsoid"
          ? globe.heightAt(geographicToDirection(latitude, longitude, _point))
          : 0;
      globe.positionAt(latitude, longitude, altitude - ground, label.position);
      _point.copy(label.position).normalize();
      const toCamera = _toward.copy(camera).sub(label.position);
      label.visible =
        _point.dot(toCamera) > 0 && // above the horizon
        toCamera.dot(forward) < 0; // in front of the camera
    } else if (child.visible) placeChildren(globe, camera, forward, child);
  }
}

// Children are in east-up-south meters. Anchors are not walked: their labels are local.
function placeAnchor(globe: PlacementGlobe, anchor: GlobeAnchor) {
  const { latitude, longitude, altitude } = anchor;
  geographicToDirection(latitude, longitude, _up);
  const ground = anchor.altitudeReference === "ellipsoid" ? globe.heightAt(_up) : 0;
  globe.positionAt(latitude, longitude, altitude - ground, anchor.position);
  const lon = THREE.MathUtils.degToRad(longitude);
  _east.set(-Math.sin(lon), 0, -Math.cos(lon));
  _south.crossVectors(_east, _up);
  anchor.quaternion.setFromRotationMatrix(_basis.makeBasis(_east, _up, _south));
}
