import assert from "node:assert/strict";
import test from "node:test";
import { loadImageryManifest, MissingImageryManifestError } from "../src/imagery/manifest.ts";

test("missing imagery handles HTTP 404 and Vite's successful HTML fallback", async (t) => {
  const url = "http://localhost:5173/data/mars/viking-preview/manifest.json";
  for (const response of [
    new Response("missing", { status: 404 }),
    new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } }),
    new Response("  <!doctype html>"),
  ]) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(
      loadImageryManifest(url),
      (error: unknown) =>
        error instanceof MissingImageryManifestError && error.message.includes(url),
    );
    t.mock.restoreAll();
  }
});

test("invalid data and server failures remain errors rather than silently missing datasets", async (t) => {
  for (const [response, pattern] of [
    [new Response("{broken"), /Invalid JSON.*manifest/],
    [Response.json({ version: 99 }), /Unsupported globe imagery/],
    [new Response("server failed", { status: 500 }), /HTTP 500/],
  ] as const) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(loadImageryManifest("https://example.test/manifest.json"), pattern);
    t.mock.restoreAll();
  }
});
