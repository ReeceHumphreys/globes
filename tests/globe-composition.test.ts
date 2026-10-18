import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { WebGPURenderer, Group, Vector3 } from "three/webgpu";
import type { GlobeSurface, GlobeContext } from "../src/composition.ts";

// Run the real engine and surface dispatch with only GPU submission and DOM mocked.
// No production test hooks; WebGPU shader/pipeline validation is separate.
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  ssr: { noExternal: ["pmtiles", "fflate"] },
  build: {
    ssr: fileURLToPath(new URL("../src/globe.ts", import.meta.url)),
    write: false,
    minify: false,
  },
});
const entry = bundle.output.find((c) => c.type === "chunk" && c.isEntry)!;
const code = entry.code.replace(
  /from (["'])(three(?:\/[^"']*)?)\1/g,
  (_, quote, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`,
);
const { createGlobe } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

for (const mode of ["direct", "pipeline", "environment"] as const) {
  const customPipeline = mode !== "direct";
  const usesEnvironment = mode === "environment";
  test(`custom surface shares Sun and owns cleanup (${mode})`, async (t) => {
    let canvases = 0,
      renders = 0,
      rendererDisposals = 0,
      removals = 0,
      observed = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const patches: [object, string, PropertyDescriptor | undefined][] = [];
    function patch(object: object, key: string, value: unknown) {
      patches.push([object, key, Object.getOwnPropertyDescriptor(object, key)]);
      Object.defineProperty(object, key, { value, configurable: true, writable: true });
    }
    t.after(() => {
      for (const [obj, key, descriptor] of patches.reverse()) {
        if (descriptor) Object.defineProperty(obj, key, descriptor);
        else Reflect.deleteProperty(obj, key);
      }
    });
    patch(globalThis, "navigator", { gpu: {}, userAgent: "test" });
    patch(globalThis, "document", {
      baseURI: "https://example.test/",
      createElementNS() {
        canvases++;
        return {
          width: 1,
          height: 1,
          clientHeight: 600,
          style: {},
          setAttribute() {},
          addEventListener() {},
          removeEventListener() {},
          remove() {
            removals++;
          },
        };
      },
    });
    patch(globalThis, "window", { devicePixelRatio: 2 });
    patch(globalThis, "fetch", () => {
      throw new Error("Custom surface must not request terrain data");
    });
    patch(globalThis, "requestAnimationFrame", (cb: FrameRequestCallback) => {
      callbacks.set(++frameId, cb);
      return frameId;
    });
    patch(globalThis, "cancelAnimationFrame", (id: number) => callbacks.delete(id));
    patch(
      globalThis,
      "ResizeObserver",
      class {
        observe() {
          observed++;
        }
        disconnect() {
          observed--;
        }
      },
    );
    patch(WebGPURenderer.prototype, "init", async function () {});
    patch(WebGPURenderer.prototype, "setSize", function () {});
    patch(WebGPURenderer.prototype, "setPixelRatio", function () {});
    patch(WebGPURenderer.prototype, "render", function () {
      renders++;
    });
    patch(WebGPURenderer.prototype, "dispose", function () {
      rendererDisposals++;
    });
    const log: string[] = [];
    let context!: GlobeContext;
    let pipelineDraws = 0,
      pipelineDisposals = 0;
    const group = new Group();
    const surface: GlobeSurface = {
      id: "gas-surface",
      stats: { imageryStatus: "procedural" },
      attach(ctx) {
        context = ctx;
        ctx.scene.add(group);
        log.push("surface:attach");
      },
      sampleHeight() {
        return 100;
      },
      update(frame) {
        assert.equal(frame.context.sun, context.sun);
        log.push("surface:update");
      },
      dispose() {
        group.removeFromParent();
        log.push("surface:dispose");
      },
    };
    const layer = {
      id: "rings",
      attach(ctx: GlobeContext) {
        assert.equal(ctx.scene, context.scene);
        log.push("rings:attach");
      },
      update(frame) {
        assert.equal(frame.context.sun, context.sun);
        log.push("rings:update");
      },
      dispose() {
        log.push("rings:dispose");
      },
    };
    const createPipeline = (ctx: GlobeContext) => {
      assert.equal(ctx.camera, context.camera);
      assert.equal(ctx.scene, context.scene);
      assert.deepEqual(log, [
        ...(usesEnvironment ? ["environment:attach"] : []),
        "surface:attach",
        "rings:attach",
      ]);
      return {
        render() {
          pipelineDraws++;
        },
        dispose() {
          pipelineDisposals++;
          log.push("pipeline:dispose");
        },
      };
    };
    const environment = usesEnvironment
      ? {
          id: "environment",
          lightsModels: true,
          attach(ctx: GlobeContext) {
            assert.equal(ctx.environment, environment);
            log.push("environment:attach");
          },
          update() {
            log.push("environment:update");
          },
          createRenderPipeline: createPipeline,
          dispose() {
            log.push("environment:dispose");
          },
        }
      : undefined;
    const globe = await createGlobe({
      container: {
        clientWidth: 800,
        clientHeight: 600,
        appendChild() {},
      } as unknown as HTMLElement,
      body: { name: "Saturn", radiusMeters: 58232000 },
      surface,
      layers: [layer],
      environment,
      renderPipeline: customPipeline && !usesEnvironment ? createPipeline : undefined,
    });
    assert.equal(canvases, 1); // Only renderer canvas; no checker texture or tile grid.
    assert.equal(renders, customPipeline ? 0 : 1);
    assert.equal(pipelineDraws, customPipeline ? 1 : 0);
    assert.equal(observed, 1);
    assert.deepEqual(log.slice(0, usesEnvironment ? 6 : 4), [
      ...(usesEnvironment ? ["environment:attach"] : []),
      "surface:attach",
      "rings:attach",
      ...(usesEnvironment ? ["environment:update"] : []),
      "surface:update",
      "rings:update",
    ]);
    assert.equal(globe.stats.tiles, 0);
    assert.equal(globe.stats.imageryStatus, "procedural");
    globe.setSun(0, 0);
    globe.render();
    assert.equal(context.sun.direction.x, 1);
    globe.setAltitude(1000);
    globe.render();
    assert.equal(Math.round(globe.stats.altitudeMeters), 1000);
    assert.throws(() => globe.setHapke(true), /does not support/);
    globe.removeLayer("rings");
    assert.equal(log.at(-1), "rings:dispose");
    assert.throws(() => globe.removeLayer(surface.id), /cannot be removed/);
    if (usesEnvironment) assert.throws(() => globe.removeLayer("environment"), /cannot be removed/);
    globe.dispose();
    globe.dispose();
    assert.ok(context.signal.aborted);
    assert.equal(group.parent, null);
    assert.equal(rendererDisposals, 1);
    assert.equal(pipelineDisposals, customPipeline ? 1 : 0);
    assert.equal(removals, 1);
    assert.equal(observed, 0);
    assert.equal(callbacks.size, 0);
    assert.equal(log.at(-1), usesEnvironment ? "environment:dispose" : "surface:dispose");
    if (customPipeline) assert.ok(log.indexOf("pipeline:dispose") < log.indexOf("surface:dispose"));
  });
}

test("focus keeps a close camera, and one throwing frame listener still draws", async (t) => {
  let renders = 0;
  const errors: unknown[] = [];
  const callbacks = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const patches: [object, string, PropertyDescriptor | undefined][] = [];
  function patch(object: object, key: string, value: unknown) {
    patches.push([object, key, Object.getOwnPropertyDescriptor(object, key)]);
    Object.defineProperty(object, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [obj, key, descriptor] of patches.reverse()) {
      if (descriptor) Object.defineProperty(obj, key, descriptor);
      else Reflect.deleteProperty(obj, key);
    }
  });
  patch(globalThis, "navigator", { gpu: {}, userAgent: "test" });
  patch(globalThis, "document", {
    baseURI: "https://example.test/",
    createElementNS() {
      return {
        width: 1,
        height: 1,
        clientHeight: 600,
        style: {},
        setAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        remove() {},
      };
    },
  });
  patch(globalThis, "window", { devicePixelRatio: 1 });
  patch(globalThis, "requestAnimationFrame", (cb: FrameRequestCallback) => {
    callbacks.set(++frameId, cb);
    return frameId;
  });
  patch(globalThis, "cancelAnimationFrame", (id: number) => callbacks.delete(id));
  patch(
    globalThis,
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  patch(WebGPURenderer.prototype, "init", async function () {});
  patch(WebGPURenderer.prototype, "setSize", function () {});
  patch(WebGPURenderer.prototype, "setPixelRatio", function () {});
  patch(WebGPURenderer.prototype, "render", function () {
    renders++;
  });
  patch(WebGPURenderer.prototype, "dispose", function () {});
  const radius = 1737400;
  const globe = await createGlobe({
    container: {
      clientWidth: 800,
      clientHeight: 600,
      appendChild() {},
    } as unknown as HTMLElement,
    body: { name: "Moon", radiusMeters: radius },
    surface: {
      id: "shell",
      attach() {},
      update() {},
      dispose() {},
      sampleHeight: () => 0,
    },
    onError: (error) => errors.push(error),
  });
  globe.camera.position.set(radius + 1, 0, 0);
  globe.render();
  assert.ok(Math.abs(globe.camera.position.length() - (radius + 10)) < 1e-4);
  const target = new Vector3(radius, 0, 0);
  globe.setCameraFocus({
    target: (out) => out.copy(target),
    distanceMeters: 5,
    minDistanceMeters: 1,
  });
  globe.render();
  assert.ok(Math.abs(globe.camera.position.distanceTo(target) - 5) < 1e-4);
  globe.setAltitude(40);
  globe.render();
  assert.ok(Math.abs(globe.camera.position.distanceTo(target) - 40) < 1e-4);
  let followed = false;
  globe.onFrame(() => {
    throw new Error("boom");
  });
  globe.onFrame(() => {
    followed = true;
  });
  const before = renders;
  assert.doesNotThrow(() => globe.render());
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "boom");
  assert.equal(followed, true);
  assert.equal(renders, before + 1);
  globe.render();
  assert.equal(renders, before + 2);
  globe.requestRender();
  assert.equal(callbacks.size, 1);
  globe.dispose();
  assert.equal(callbacks.size, 0);
});

test("a provider-owned compositor rejects conflicting application configuration", async () => {
  await assert.rejects(
    createGlobe({
      body: { name: "Mars", radiusMeters: 3396190 },
      environment: {
        id: "environment",
        attach() {},
        update() {},
        dispose() {},
        createRenderPipeline() {},
      },
      renderPipeline() {},
    }),
    /either environment or renderPipeline/,
  );
});
