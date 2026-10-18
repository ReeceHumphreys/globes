import assert from "node:assert/strict";
import test from "node:test";
import { Scene, PerspectiveCamera, Vector3 } from "three/webgpu";
import { createLayerHost } from "../src/layer-host.ts";
import type { GlobeContext, GlobeLayer, GlobeFrame } from "../src/composition.ts";

function fixture() {
  const abort = new AbortController();
  const errors: unknown[] = [];
  const context = {
    body: { name: "Mars", radiusMeters: 3389500 },
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    renderer: {},
    sun: { direction: new Vector3(1, 0, 0), longitudeDeg: 0, latitudeDeg: 0 },
    viewport: { width: 800, height: 600, pixelRatio: 1 },
    signal: abort.signal,
    requestRender() {},
    reportError(error: unknown) {
      errors.push(error);
    },
    sampleHeight() {
      return 42;
    },
  } as GlobeContext;
  const frame: GlobeFrame = { context, now: 100, elapsedSeconds: 0, deltaSeconds: 0 };
  return { context, frame, abort, errors, host: createLayerHost(context) };
}

test("surface and scene layers share state, update in order, and dispose in reverse order", async () => {
  const { host, context, frame } = fixture();
  const log: string[] = [];
  let signal: AbortSignal;
  const layer = (id: string): GlobeLayer => ({
    id,
    attach(ctx) {
      assert.equal(ctx.scene, context.scene);
      assert.equal(ctx.sun, context.sun);
      signal = ctx.signal;
      log.push(`attach:${id}`);
    },
    update(frame) {
      assert.equal(frame.context.sun.direction.x, 0.5);
      assert.equal(frame.context.sampleHeight(1, 0, 0), 42);
      log.push(`update:${id}`);
    },
    dispose() {
      log.push(`dispose:${id}`);
    },
  });
  await host.add(layer("surface"));
  await host.add(layer("rings"));
  context.sun.direction.set(0.5, 0, 0);
  host.update(frame);
  host.dispose();
  host.dispose();
  host.update(frame);
  assert.ok(signal!.aborted);
  assert.deepEqual(log, [
    "attach:surface",
    "attach:rings",
    "update:surface",
    "update:rings",
    "dispose:rings",
    "dispose:surface",
  ]);
  await assert.rejects(host.add(layer("late")), /disposed/);
});

test("removing an attaching layer aborts it and cleans up late resources exactly once", async () => {
  const { host, frame } = fixture();
  let resolve!: () => void;
  let signal: AbortSignal;
  let updates = 0,
    disposals = 0;
  const layer: GlobeLayer = {
    id: "sky",
    attach(ctx) {
      signal = ctx.signal;
      return new Promise<void>((r) => {
        resolve = r;
      });
    },
    update() {
      updates++;
    },
    dispose() {
      disposals++;
    },
  };
  const attaching = host.add(layer);
  host.remove("sky");
  assert.ok(signal!.aborted);
  host.update(frame);
  assert.equal(updates, 0);
  resolve();
  await attaching;
  host.dispose();
  assert.equal(disposals, 1);
});

test("attachment failure releases partial resources and duplicate IDs cannot replace live layers", async () => {
  const { host, errors } = fixture();
  let disposals = 0;
  const broken: GlobeLayer = {
    id: "bad",
    attach() {
      throw new Error("shader failed");
    },
    update() {},
    dispose() {
      disposals++;
    },
  };
  await assert.rejects(host.add(broken), /shader failed/);
  assert.equal(disposals, 1);
  const good: GlobeLayer = {
    id: "good",
    attach() {},
    update() {},
    dispose() {
      disposals++;
    },
  };
  await host.add(good);
  await assert.rejects(host.add({ ...good }), /Duplicate/);
  host.remove("good");
  await assert.rejects(host.add(good), /twice/);
  host.dispose();
  assert.equal(disposals, 2);
  assert.deepEqual(errors, []);
});
