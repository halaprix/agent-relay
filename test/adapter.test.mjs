import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("example adapter routes package tests and Solidity delivery distinctly", async () => {
  const { adapter } = await loadAdapter("example-app");
  assert.deepEqual(adapter.gates.routing.implementationDefault, ["sdk-package", "app-package"]);
  assert.deepEqual(adapter.gates.routing.deliveryDefault, [
    "formatting",
    "workspace-lint-check-types",
    "sdk-package",
    "app-package"
  ]);
  assert.deepEqual(adapter.gates.routing.deliveryByRisk["solidity-core"], [
    "formatting",
    "workspace-lint-check-types",
    "sdk-package",
    "app-package",
    "solidity"
  ]);
});

test("syncAdapters --check fails on registry drift", async () => {
  const outputPath = path.join(await mkdtemp(path.join(os.tmpdir(), "agent-relay-adapters-")), "adapters.json");
  await syncAdapters({ outputPath });
  const original = await readFile(outputPath, "utf8");
  await writeFile(outputPath, original.replace("\"dev\"", "\"main\""), "utf8");
  await assert.rejects(() => syncAdapters({ check: true, outputPath }), /generated adapter registry drift detected/);
});
