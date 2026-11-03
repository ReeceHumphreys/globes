import assert from "node:assert/strict";
import test from "node:test";
import { matchesBody } from "../src/body.ts";

test("datasets must name the same body and radius", () => {
  for (const body of [
    { name: "Moon", radiusMeters: 1737400 },
    { name: "Mars", radiusMeters: 3389500 },
    { name: "Earth", radiusMeters: 6371000 },
  ]) {
    assert.ok(matchesBody({ body: body.name, radiusMeters: body.radiusMeters }, body));
    assert.ok(!matchesBody({ body: body.name, radiusMeters: body.radiusMeters + 1000 }, body));
    assert.ok(!matchesBody({ body: "another", radiusMeters: body.radiusMeters }, body));
  }
});
