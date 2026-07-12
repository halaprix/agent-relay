import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { repoPath } from "../src/lib/paths.mjs";
import { defaultAdapterRegistryPath, loadAdapter, syncAdapters, validateAdapter } from "../src/lib/adapter.mjs";

async function createArchiveFixture() {
  const archiveRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "agent-relay-archive-")), "repo");
  await cp(repoPath(), archiveRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(repoPath(), source);
      return ![".git", ".generated", "node_modules"].some(
        (prefix) => relative === prefix || relative.startsWith(`${prefix}${path.sep}`)
      );
    }
  });
  return archiveRoot;
}

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

test("npm run check passes from an archive-style checkout without ignored generated output", async () => {
  const archiveRoot = await createArchiveFixture();
  const registryPath = path.join(archiveRoot, "adapters", "registry.json");
  assert.equal(registryPath.endsWith(path.relative(repoPath(), defaultAdapterRegistryPath())), true);
  const run = spawnSync("npm", ["run", "check"], {
    cwd: archiveRoot,
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
