import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { LinearFilter, RedFormat, RepeatWrapping } from "three/webgpu";
import { decodeCloudNoise, loadCloudNoise } from "../examples/planets/cloud-noise.ts";

test("bundled cloud volumes match pinned upstream bytes and decode as repeating linear R8", async () => {
  const root = new URL("../examples/planets/assets/clouds/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  for (const file of manifest.files) {
    const bytes = await readFile(new URL(file.name, root));
    assert.equal(bytes.byteLength, file.size ** 3);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    const volume = decodeCloudNoise(bytes, file.size);
    assert.equal(volume.image.width, file.size);
    assert.equal(volume.image.depth, file.size);
    assert.equal(volume.format, RedFormat);
    assert.equal(volume.minFilter, LinearFilter);
    assert.equal(volume.magFilter, LinearFilter);
    assert.deepEqual(
      [volume.wrapS, volume.wrapT, volume.wrapR],
      [RepeatWrapping, RepeatWrapping, RepeatWrapping],
    );
    volume.dispose();
  }
});

test("noise loader rejects HTML fallback, LFS pointers, failed requests and aborted loads", async (t) => {
  assert.throws(
    () =>
      decodeCloudNoise(new TextEncoder().encode("version https://git-lfs.github.com/spec/v1"), 128),
    /R8 samples/,
  );
  assert.throws(() => decodeCloudNoise(new Uint8Array(8), 1.5), /R8 samples/);
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => new Response("<!doctype html>"));
  await assert.rejects(loadCloudNoise("shape", "detail", controller.signal), /R8 samples/);
  t.mock.method(globalThis, "fetch", async () => new Response("missing", { status: 404 }));
  await assert.rejects(loadCloudNoise("shape", "detail", controller.signal), /404/);
  controller.abort();
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(8)));
  await assert.rejects(loadCloudNoise("shape", "detail", controller.signal), {
    name: "AbortError",
  });
});

test("loaded cloud textures are disposed by their bundle owner", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (input) => new Response(new Uint8Array(String(input) === "shape" ? 128 ** 3 : 32 ** 3)),
  );
  const bundle = await loadCloudNoise("shape", "detail", new AbortController().signal);
  let disposed = 0;
  bundle.shape.addEventListener("dispose", () => disposed++);
  bundle.detail.addEventListener("dispose", () => disposed++);
  assert.equal(disposed, 0);
  bundle.dispose();
  assert.equal(disposed, 2);
});
