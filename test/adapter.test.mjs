import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { repoPath } from "../src/lib/paths.mjs";
import {
  beadsStoreIsTracked,
  defaultAdapterRegistryPath,
  loadAdapter,
  resolveBeadsDir,
  resolveResourcesRootName,
  syncAdapters,
  validateAdapter
} from "../src/lib/adapter.mjs";
import { createRepoFixture } from "./helpers.mjs";

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

test("example adapter keeps the beads store project-local and untracked", async () => {
  const { adapter } = await loadAdapter("example-app");
  assert.equal(adapter.beads.requiredDir, ".beads");
  assert.equal(beadsStoreIsTracked(adapter), false);
  assert.equal(adapter.controlPlane.protectedPaths.includes(".beads"), true);
  assert.equal(resolveBeadsDir(adapter, "/tmp/project"), path.join("/tmp/project", ".beads"));
});

test("resolveBeadsDir keeps absolute stores and rejects escapes", async () => {
  const { adapter } = await loadAdapter("example-app");
  const absoluteAdapter = { beads: { requiredDir: "/srv/shared-beads", memoryKey: "key" } };
  assert.equal(resolveBeadsDir(absoluteAdapter, "/tmp/project"), "/srv/shared-beads");
  assert.throws(
    () =>
      validateAdapter({
        ...adapter,
        beads: { ...adapter.beads, requiredDir: "../outside-beads" }
      }),
    /must stay inside the project/
  );
  assert.throws(
    () =>
      validateAdapter({
        ...adapter,
        beads: { ...adapter.beads, tracked: "yes" }
      }),
    /beads.tracked must be boolean/
  );
});

test("resolveResourcesRootName defaults to .resources and honors adapter overrides", async () => {
  const { adapter } = await loadAdapter("example-app");
  assert.equal(resolveResourcesRootName(adapter), ".resources");
  assert.equal(resolveResourcesRootName(null), ".resources");
  assert.equal(resolveResourcesRootName({ guidance: { resourcesRoot: ".cache/reference" } }), ".cache/reference");
  assert.throws(
    () => resolveResourcesRootName({ guidance: { resourcesRoot: "../escape" } }),
    /relative path inside the project/
  );
});

test("syncAdapters --check fails on registry drift", async () => {
  const repoRoot = await createRepoFixture();
  const registryPath = path.join(repoRoot, "adapters", "registry.json");
  const original = await readFile(registryPath, "utf8");
  await writeFile(registryPath, original.replace("\"dev\"", "\"main\""), "utf8");
  const run = spawnSync(process.execPath, ["scripts/sync-adapters.mjs", "--check"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /generated adapter registry drift detected/);
});

test("npm run check passes from an archive-style checkout without ignored generated output", async () => {
  const archiveRoot = await createRepoFixture({ exclude: [".generated"] });
  const registryPath = path.join(archiveRoot, "adapters", "registry.json");
  assert.equal(registryPath.endsWith(path.relative(repoPath(), defaultAdapterRegistryPath())), true);
  const run = spawnSync("npm", ["run", "check"], {
    cwd: archiveRoot,
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
