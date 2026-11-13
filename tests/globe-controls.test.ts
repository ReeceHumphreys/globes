import assert from "node:assert/strict";
import test from "node:test";
import { Object3D, PerspectiveCamera, Raycaster, Scene, Vector3 } from "three/webgpu";
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
  setPointerCapture() {}
  releasePointerCapture() {}
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

test("a drag grabs the surface in the globe frame, not the height under the camera", () => {
  const scene = new Scene();
  const body = globe(() => 4000);
  body.position.set(0, 1e9, 0);
  scene.add(body);
  const center = new Vector3(radius, 0, 0);
  const side = new Vector3(0, 0, radius);
  body.raycast = (
    raycaster: Raycaster,
    intersects: { distance: number; point: Vector3; object: Object3D }[],
  ) => {
    assert.equal(raycaster.far, Infinity);
    const toward = body.getWorldPosition(new Vector3()).sub(raycaster.ray.origin).normalize();
    const local = raycaster.ray.direction.dot(toward) > 0.999 ? center : side;
    const point = body.localToWorld(local.clone());
    intersects.push({ distance: raycaster.ray.origin.distanceTo(point), point, object: body });
  };
  const camera = new PerspectiveCamera(60, 1.5, 10, 2000);
  camera.position.set(radius + 7000, 1e9, 0);
  const controls = new GlobeControls(camera, new Canvas() as unknown as HTMLElement, body as Globe);
  const pointer = (type: string, x: number, y: number) =>
    Object.assign(new Event(type), { button: 0, clientX: x, clientY: y, pointerId: 1 });
  controls.domElement.dispatchEvent(pointer("pointerdown", 600, 400));
  controls.domElement.dispatchEvent(pointer("pointermove", 760, 400));
  // Center hit is local +X and the offset hit is local +Z, so the grab turns +X onto +Z.
  assert.ok(
    camera.position.distanceTo(new Vector3(0, 0, -(radius + 7000))) < 1,
    camera.position.toArray().join(","),
  );
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
