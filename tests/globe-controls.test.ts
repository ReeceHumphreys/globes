import assert from "node:assert/strict";
import test from "node:test";
import { Object3D, PerspectiveCamera, Scene, Vector3 } from "three/webgpu";
import { geographicToDirection } from "../src/geographic.ts";
import { GlobeControls } from "../src/globe-controls.ts";

class Canvas extends EventTarget {
  style = { touchAction: "pan-y" };
  clientHeight = 800;
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1200, height: 800 };
  }
  hasPointerCapture() {
    return false;
  }
}
const radius = 1737400;
// The controls need only a globe's radius and displayed height; a stand-in Object3D works.
function globe(height = () => 0) {
  return Object.assign(new Object3D(), {
    radius,
    flattening: 0,
    heightAt: (_direction: Vector3) => height(),
    normalAt: (point: Vector3, target = new Vector3()) => target.copy(point).normalize(),
    altitudeOf: (point: Vector3) => point.length() - radius,
    positionAt(latitudeDeg: number, longitudeDeg: number, altitude = 0, target = new Vector3()) {
      return geographicToDirection(latitudeDeg, longitudeDeg, target).multiplyScalar(
        radius + height() + altitude,
      );
    },
  });
}
type Globe = ConstructorParameters<typeof GlobeControls>[2];

test("controls adopt the camera into the globe's frame and keep it above the terrain", () => {
  const scene = new Scene(),
    body = globe();
  scene.add(body);
  body.position.set(1e9, 0, 0); // the globe need not sit at the origin
  scene.updateMatrixWorld(true);
  const camera = new PerspectiveCamera(60, 1.5);
  scene.add(camera);
  camera.position.set(1e9, 0, radius * 2);
  const controls = new GlobeControls(camera, new Canvas() as unknown as HTMLElement, body as Globe);
  assert.equal(camera.parent, body);
  assert.ok(
    camera.position.distanceTo(new Vector3(0, 0, radius * 2)) < 1e-3,
    "world transform kept",
  );
  camera.position.setLength(radius + 1);
  controls.update();
  assert.ok(Math.abs(controls.altitude - 10) < 1e-6, "clamped to minAltitude");
  assert.ok(camera.near > 0 && camera.far > camera.position.length());
  controls.dispose();
});

test("goTo and altitude move the camera and announce a change", () => {
  let changes = 0;
  const body = globe(),
    camera = new PerspectiveCamera(60, 1.5);
  const controls = new GlobeControls(camera, new Canvas() as unknown as HTMLElement, body as Globe);
  controls.addEventListener("change", () => changes++);
  controls.goTo(0, 90, 5000);
  controls.update();
  assert.ok(camera.position.distanceTo(new Vector3(0, 0, -(radius + 5000))) < 1e-3);
  controls.altitude = 2000;
  assert.ok(Math.abs(controls.altitude - 2000) < 1e-6);
  assert.equal(changes, 2);
  assert.throws(() => (controls.altitude = 1), RangeError);
  assert.throws(() => controls.goTo(91, 0), RangeError);
  controls.dispose();
});

test("altitude is kept when elevation arrives beneath a still camera", () => {
  let ground = 0;
  const body = globe(() => ground),
    camera = new PerspectiveCamera(60, 1.5);
  const controls = new GlobeControls(camera, new Canvas() as unknown as HTMLElement, body as Globe);
  controls.goTo(10, 10, 3000);
  controls.update();
  ground = 2500;
  controls.update();
  assert.ok(Math.abs(controls.altitude - 3000) < 1e-6);
  controls.dispose();
});
