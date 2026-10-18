import assert from "node:assert/strict";
import test from "node:test";
import { resolveDatasetURL } from "../src/data-url.ts";

test("dataset locations support same-origin proxies and deployed service prefixes", () => {
  const path = "data/moon/wac/manifest.json";
  assert.equal(
    resolveDatasetURL(path, "https://app.test/viewer/"),
    "https://app.test/viewer/" + path,
  );
  assert.equal(
    resolveDatasetURL(path, "https://app.test/viewer/", "http://127.0.0.1:8787"),
    "http://127.0.0.1:8787/" + path,
  );
  assert.equal(
    resolveDatasetURL(path, "https://app.test/", "https://files.test/releases/v2"),
    "https://files.test/releases/v2/" + path,
  );
  assert.equal(
    resolveDatasetURL("/" + path, "https://app.test/", "/files/"),
    "https://app.test/files/" + path,
  );
});
