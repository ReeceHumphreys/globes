import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  decodeOceanMask,
  loadOceanMask,
  OCEAN_MASK_WIDTH as width,
  OCEAN_MASK_HEIGHT as height,
} from "../examples/planets/ocean.ts";
import { RedFormat, NoColorSpace, RepeatWrapping, ClampToEdgeWrapping } from "three/webgpu";

test("bundled ocean coverage has the pinned hash, orientation and geographic classification", async () => {
  const directory = new URL("../examples/planets/assets/ocean/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  const bytes = gunzipSync(await readFile(new URL("water-mask.bin.gz", directory)));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.sha256);
  const at = (lon: number, lat: number) =>
    bytes[
      Math.floor(((90 - lat) / 180) * height) * width + Math.floor(((lon + 180) / 360) * width)
    ];
  for (const [lon, lat] of [
    [-150, 0],
    [-30, 0],
    [80, -20],
    [-179, 0],
    [179, 0],
  ])
    assert.equal(at(lon, lat), 255);
  for (const [lon, lat] of [
    [2, 49],
    [10, 24],
    [-40, 75],
    [0, -85],
    [100, 40],
  ])
    assert.equal(at(lon, lat), 0);
  const texture = decodeOceanMask(bytes);
  assert.equal(texture.format, RedFormat);
  assert.equal(texture.colorSpace, NoColorSpace);
  assert.equal(texture.flipY, false);
  assert.equal(texture.wrapS, RepeatWrapping);
  assert.equal(texture.wrapT, ClampToEdgeWrapping);
  assert.equal(texture.generateMipmaps, true);
  texture.dispose();
});

test("ocean loader rejects missing, corrupt and aborted assets", async (t) => {
  const controller = new AbortController();
  assert.throws(() => decodeOceanMask(new Uint8Array(4)), /mask size/);
  t.mock.method(globalThis, "fetch", async () => new Response("missing", { status: 404 }));
  await assert.rejects(loadOceanMask("/ocean", controller.signal), /404/);
  t.mock.method(globalThis, "fetch", async () => new Response("<!doctype html>"));
  await assert.rejects(loadOceanMask("/ocean", controller.signal));
  const packed = await readFile(
    new URL("../examples/planets/assets/ocean/water-mask.bin.gz", import.meta.url),
  );
  t.mock.method(globalThis, "fetch", async () => new Response(packed));
  controller.abort();
  await assert.rejects(loadOceanMask("/ocean", controller.signal), { name: "AbortError" });
});

test("ocean loader accepts static gzip files and Fetch-decoded Content-Encoding responses", async (t) => {
  const packed = await readFile(
    new URL("../examples/planets/assets/ocean/water-mask.bin.gz", import.meta.url),
  );
  const raw = gunzipSync(packed);
  for (const body of [packed, raw]) {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    const texture = await loadOceanMask("/mask", new AbortController().signal);
    assert.equal(texture.image.data.length, width * height);
    assert.equal(
      createHash("sha256").update(texture.image.data).digest("hex"),
      createHash("sha256").update(raw).digest("hex"),
    );
    texture.dispose();
  }
});
