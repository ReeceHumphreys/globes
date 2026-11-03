import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "three/webgpu";
import { createOrbitInput } from "../src/controls.ts";
import { pickGlobe } from "../src/orbit.ts";

class Canvas extends EventTarget {
  style = { touchAction: "pan-y" };
  clientHeight = 800;
  captures = new Set<number>();
  getBoundingClientRect() {
    return { left: 20, top: 30, width: 1200, height: 800 };
  }
  setPointerCapture(id: number) {
    this.captures.add(id);
  }
  hasPointerCapture(id: number) {
    return this.captures.has(id);
  }
  releasePointerCapture(id: number) {
    this.captures.delete(id);
  }
  send(type: string, props: object) {
    const event = Object.assign(new Event(type, { cancelable: true }), props);
    this.dispatchEvent(event);
    return event;
  }
}

test("wheel zoom anchors the cursor, honors altitude limits, and removes handlers on disposal", () => {
  const radius = 6378137,
    canvas = new Canvas();
  const camera = new PerspectiveCamera(60, 1.5, 0.1, radius * 20);
  camera.position.set(0, 0, radius * 3);
  let draws = 0;
  const controls = createOrbitInput(
    canvas as unknown as HTMLCanvasElement,
    camera,
    radius,
    10,
    () => 0,
    () => {
      draws++;
      controls.aim();
    },
  );
  controls.aim();
  const anchor = new Vector3(),
    after = new Vector3();
  assert.ok(pickGlobe(camera, 0.1, 0.05, radius, anchor));
  const wheel = canvas.send("wheel", { deltaY: -300, deltaMode: 0, clientX: 680, clientY: 410 });
  assert.ok(wheel.defaultPrevented);
  assert.ok(pickGlobe(camera, 0.1, 0.05, radius, after));
  assert.ok(anchor.distanceTo(after) < 1e-8);
  assert.ok(camera.position.length() < radius * 3);
  for (let i = 0; i < 20; i++)
    canvas.send("wheel", {
      deltaY: -10000,
      deltaMode: 0,
      clientX: 620,
      clientY: 430,
    });
  assert.ok(camera.position.length() >= radius + 10 - 1e-7);
  controls.dispose();
  assert.equal(canvas.style.touchAction, "pan-y");
  const oldDraws = draws;
  canvas.send("wheel", { deltaY: 100, deltaMode: 0, clientX: 620, clientY: 430 });
  assert.equal(draws, oldDraws);
});

test("touch pinch zooms and hands back to one-finger dragging without a jump", () => {
  const radius = 1737400,
    canvas = new Canvas();
  const camera = new PerspectiveCamera(60, 1.5, 0.1, radius * 20);
  camera.position.set(0, 0, radius * 3);
  const controls = createOrbitInput(
    canvas as unknown as HTMLCanvasElement,
    camera,
    radius,
    10,
    () => 0,
    () => controls.aim(),
  );
  controls.aim();
  const down = (pointerId: number, clientX: number) =>
    canvas.send("pointerdown", {
      pointerId,
      clientX,
      clientY: 430,
      button: 0,
      shiftKey: false,
    });
  down(1, 570);
  down(2, 670);
  const before = camera.position.length();
  canvas.send("pointermove", { pointerId: 2, clientX: 720, clientY: 430 });
  assert.ok(camera.position.length() < before);
  canvas.send("pointerup", { pointerId: 2 });
  const position = camera.position.clone();
  canvas.send("pointermove", { pointerId: 1, clientX: 570, clientY: 430 });
  assert.ok(camera.position.distanceTo(position) < 1e-7);
  controls.dispose();
  assert.equal(canvas.captures.size, 0);
});
