import assert from "node:assert/strict";
import test from "node:test";
import { Scene, PerspectiveCamera, Vector3, WebGPUCoordinateSystem } from "three/webgpu";
import { createMarkerLayer, projectMarker } from "../src/markers.ts";
import type { GlobeContext, GlobeFrame } from "../src/composition.ts";

function cameraAt(radius: number) {
  const camera = new PerspectiveCamera(75, 2, 1, radius * 20);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  (camera as unknown as { _reversedDepth: boolean })._reversedDepth = true;
  camera.position.set(radius * 3, 0, 0);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}
test("marker projection works for different radii, far sides, poles, and zero-sized views", () => {
  for (const radius of [1737400, 3389500, 6371000]) {
    const camera = cameraAt(radius);
    const center = projectMarker({ latitudeDeg: 0, longitudeDeg: 0 }, camera, radius, 800, 400);
    assert.equal(center.visible, true);
    assert.ok(Math.abs(center.x - 400) < 1e-8);
    assert.ok(Math.abs(center.y - 200) < 1e-8);
    assert.equal(
      projectMarker({ latitudeDeg: 0, longitudeDeg: 180 }, camera, radius, 800, 400).visible,
      false,
    );
    assert.equal(
      projectMarker({ latitudeDeg: 0, longitudeDeg: 0 }, camera, radius, 0, 400).visible,
      false,
    );
    camera.position.set(0, radius * 3, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    const pole = projectMarker({ latitudeDeg: 90, longitudeDeg: 0 }, camera, radius, 800, 400);
    assert.ok(pole.visible);
    assert.ok(Math.abs(pole.x - 400) < 1e-8);
    assert.ok(Math.abs(pole.y - 200) < 1e-8);
  }
});

class Element {
  styleWrites = 0;
  hiddenWrites = 0;
  removed = false;
  textContent = "";
  dataset: Record<string, string> = {};
  className = "";
  children: Element[] = [];
  parent: Element | undefined;
  style = new Proxy({} as Record<string, string>, {
    set: (target, key, value) => {
      this.styleWrites++;
      target[String(key)] = value;
      return true;
    },
  });
  #hidden = false;
  set hidden(value: boolean) {
    this.hiddenWrites++;
    this.#hidden = value;
  }
  get hidden() {
    return this.#hidden;
  }
  append(child: Element) {
    this.children.push(child);
    child.parent = this;
  }
  remove() {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
}

test("marker layer mounts inside its viewport, caches DOM writes, filters arbitrary groups, and cleans up", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement() {
        return new Element();
      },
    },
    configurable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const radius = 3389500,
    container = new Element();
  let requests = 0,
    samples = 0,
    matrices = 0;
  const camera = cameraAt(radius),
    update = camera.updateMatrixWorld.bind(camera);
  camera.updateMatrixWorld = (force?: boolean) => {
    matrices++;
    update(force);
  };
  const context = {
    container,
    scene: new Scene(),
    camera,
    renderer: {},
    body: { name: "Mars", radiusMeters: radius },
    sun: { direction: new Vector3(1, 0, 0), longitudeDeg: 0, latitudeDeg: 0 },
    viewport: { width: 800, height: 400, pixelRatio: 2 },
    signal: new AbortController().signal,
    requestRender() {
      requests++;
    },
    reportError(error) {
      throw error;
    },
    sampleHeight() {
      samples++;
      return 123;
    },
  } as unknown as GlobeContext;
  const source = [
    { id: "rover", label: "<rover>", group: "science", latitudeDeg: 0, longitudeDeg: 0 },
    { id: "far", label: "Far", latitudeDeg: 0, longitudeDeg: 180 },
    { id: "feature", label: "Feature", latitudeDeg: 10, longitudeDeg: 0 },
  ];
  const layer = createMarkerLayer(source);
  layer.setGroupVisible("science", false); // Can configure before attachment.
  layer.attach(context);
  const root = container.children[0],
    [rover, far, feature] = root.children;
  assert.equal(rover.textContent, "<rover>"); // text, never HTML
  const frame: GlobeFrame = { context, now: 100, deltaSeconds: 0, elapsedSeconds: 0 };
  layer.update(frame);
  assert.equal(rover.hidden, true);
  assert.equal(far.hidden, true);
  assert.equal(feature.hidden, false);
  assert.equal(matrices, 1);
  assert.equal(samples, 1);
  const writes = feature.styleWrites,
    hiddenWrites = feature.hiddenWrites;
  layer.update(frame);
  assert.equal(feature.styleWrites, writes);
  assert.equal(feature.hiddenWrites, hiddenWrites);
  layer.setGroupVisible("science", true);
  layer.update(frame);
  assert.equal(rover.hidden, false);
  layer.setMarkerVisible("rover", false);
  layer.update(frame);
  assert.equal(rover.hidden, true);
  assert.throws(() => layer.setMarkerVisible("missing", false), /Unknown/);
  layer.setMarkerVisible("rover", true);
  source[0].latitudeDeg = NaN; // Factory snapshots caller records.
  layer.update(frame);
  assert.equal(rover.hidden, false);
  assert.ok(requests >= 3);
  layer.dispose();
  layer.dispose();
  assert.equal(container.children.length, 0);
  assert.equal(root.removed, true);
});

test("marker catalogs reject ambiguous IDs and invalid coordinates", () => {
  const marker = { id: "one", label: "one", latitudeDeg: 0, longitudeDeg: 0 };
  assert.throws(() => createMarkerLayer([marker, marker]), /Duplicate/);
  assert.throws(() => createMarkerLayer([{ ...marker, id: "" }]), /empty/);
  for (const latitudeDeg of [NaN, 91, -91])
    assert.throws(() => createMarkerLayer([{ ...marker, latitudeDeg }]), /Invalid/);
  assert.throws(() => createMarkerLayer([{ ...marker, longitudeDeg: 181 }]), /Invalid/);
  assert.throws(() => createMarkerLayer([{ ...marker, heightOffsetMeters: Infinity }]), /Invalid/);
});
