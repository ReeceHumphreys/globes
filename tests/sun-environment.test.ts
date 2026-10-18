import assert from "node:assert/strict";
import test from "node:test";
import { Scene, Vector3 } from "three/webgpu";
import { createSunEnvironment } from "../src/rendering/sun-environment.ts";
import { createLanderLayer } from "../examples/moon/rendering/landers.ts";

test("one airless environment supplies model lights and follows the shared Sun", () => {
  const environment = createSunEnvironment();
  const context = {
    scene: new Scene(),
    body: { radiusMeters: 1737400 },
    sun: { direction: new Vector3(1, 0, 0) },
  };
  environment.attach(context);
  const lights = context.scene.children.filter((object) => object.isLight);
  assert.equal(lights.length, 2);
  assert.equal(environment.lightsModels, true);
  const sun = lights.find((light) => light.isDirectionalLight);
  assert.equal(sun.intensity, 3);
  assert.deepEqual(sun.position.clone().normalize().toArray(), [1, 0, 0]);
  context.sun.direction.set(0, 1, 0);
  environment.update({ context });
  assert.deepEqual(sun.position.clone().normalize().toArray(), [0, 1, 0]);
  const landers = createLanderLayer("https://example.test/", () => {}, false);
  assert.equal(landers.group.children.filter((object) => object.isLight).length, 0);
  landers.dispose();
  environment.dispose();
  environment.dispose();
  assert.equal(context.scene.children.length, 0);
});

test("model environment rejects invalid intensities before allocating lights", () => {
  assert.throws(() => createSunEnvironment({ directIntensity: -1 }), /nonnegative/);
  assert.throws(() => createSunEnvironment({ ambientIntensity: NaN }), /nonnegative/);
});
