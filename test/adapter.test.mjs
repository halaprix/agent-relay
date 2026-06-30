import test from "node:test";
import assert from "node:assert/strict";
import { loadAdapter, syncAdapters, validateAdapter } from "../src/lib/adapter.mjs";

test("example adapter validates", async () => {
  const { adapter } = await loadAdapter("example-app");
  assert.equal(adapter.name, "example-app");
  validateAdapter(adapter);
});

test("syncAdapters returns registry data", async () => {
  const registry = await syncAdapters({ check: true });
  assert.equal(registry.length >= 1, true);
  assert.equal(registry[0].name, "example-app");
});
