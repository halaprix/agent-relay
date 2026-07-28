import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { writeJson } from "../src/lib/fs.mjs";
import { repoPath } from "../src/lib/paths.mjs";
import {
  AdapterResolutionError,
  beadsExcludeMarker,
  beadsStoreIsTracked,
  defaultAdapterRegistryPath,
  loadAdapter,
  projectAdapterPath,
  resolveAdapter,
  resolveBeadsDir,
  resolveResourcesRootName,
  syncAdapters,
  validateAdapter
} from "../src/lib/adapter.mjs";
import { cleanupFixtures, createProjectFixture, createRepoFixture, writeProjectAdapter } from "./helpers.mjs";

test.after(cleanupFixtures);

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

test("example adapter keeps the beads store project-local and tracked", async () => {
  const { adapter } = await loadAdapter("example-app");
  assert.equal(adapter.beads.requiredDir, ".beads");
  assert.equal(beadsStoreIsTracked(adapter), true);
  assert.equal(adapter.controlPlane.protectedPaths.includes(".beads"), true);
  assert.equal(resolveBeadsDir(adapter, "/tmp/project"), path.join("/tmp/project", ".beads"));
});

test("beadsExcludeMarker only fires for a relative, untracked store", () => {
  assert.equal(beadsExcludeMarker({ beads: { requiredDir: ".beads", tracked: true } }), null);
  assert.equal(beadsExcludeMarker({ beads: { requiredDir: ".beads", tracked: false } }), ".beads/");
  assert.equal(beadsExcludeMarker({ beads: { requiredDir: ".beads" } }), ".beads/");
  assert.equal(beadsExcludeMarker({ beads: { requiredDir: "state/beads/" } }), "state/beads/");
  assert.equal(beadsExcludeMarker({ beads: { requiredDir: "/srv/shared-beads" } }), null);
  assert.equal(beadsExcludeMarker({ beads: {} }), null);
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

// agent-relay-ynq: a project's own adapter is core to that project, not to Agent Relay,
// so it must be resolvable from the project's own repository rather than only from a
// file committed into this one. These tests cover the precedence contract directly -
// see resolveAdapter's own doc comment in src/lib/adapter.mjs for the rule it implements.

test("resolveAdapter finds a project-local adapter when no flag is given", async () => {
  const projectRoot = await createProjectFixture();
  const adapterPath = await writeProjectAdapter(projectRoot, { name: "my-real-project" });
  const resolved = await resolveAdapter({ projectRoot });
  assert.equal(resolved.source, "project");
  assert.equal(resolved.adapterPath, adapterPath);
  assert.equal(resolved.adapter.name, "my-real-project");
});

test("resolveAdapter never defaults to a bundled example when nothing is configured", async () => {
  const projectRoot = await createProjectFixture();
  await assert.rejects(() => resolveAdapter({ projectRoot }), (error) => {
    assert.ok(error instanceof AdapterResolutionError);
    assert.match(error.message, /no adapter configured/);
    assert.ok(
      error.message.includes(projectAdapterPath(projectRoot)),
      "the error must name the exact path that was checked"
    );
    return true;
  });
});

test("resolveAdapter --adapter-file wins over a project-local adapter, and a missing file is a clear error", async () => {
  const projectRoot = await createProjectFixture();
  await writeProjectAdapter(projectRoot, { name: "the-project-default" });
  const explicitPath = path.join(projectRoot, "custom-adapter.json");
  const explicit = JSON.parse(JSON.stringify((await resolveAdapter({ projectRoot })).adapter));
  explicit.name = "explicit-file-adapter";
  await writeJson(explicitPath, explicit);

  const resolved = await resolveAdapter({ projectRoot, adapterFile: explicitPath });
  assert.equal(resolved.source, "explicit-file");
  assert.equal(resolved.adapter.name, "explicit-file-adapter");

  await assert.rejects(
    () => resolveAdapter({ projectRoot, adapterFile: "does-not-exist.json" }),
    /--adapter-file does not exist/
  );
});

test("resolveAdapter --adapter wins over a project-local adapter, and an unknown bundled name is a clear error rather than a fallback", async () => {
  const projectRoot = await createProjectFixture();
  await writeProjectAdapter(projectRoot, { name: "the-project-default" });

  const resolved = await resolveAdapter({ projectRoot, adapterName: "example-app" });
  assert.equal(resolved.source, "bundled");
  assert.equal(resolved.adapter.name, "example-app");

  // An explicit --adapter names bundled intent specifically - it must not silently fall
  // through to the project-local file just because that name is not bundled.
  await assert.rejects(
    () => resolveAdapter({ projectRoot, adapterName: "not-a-real-bundled-adapter" }),
    (error) => {
      assert.ok(error instanceof AdapterResolutionError);
      assert.match(error.message, /not one of the adapters bundled with Agent Relay/);
      return true;
    }
  );
});

test("resolveAdapter validates a project-local adapter with the same gate as a bundled one", async () => {
  const projectRoot = await createProjectFixture();
  await writeProjectAdapter(projectRoot, { beads: { requiredDir: 5, memoryKey: "x" } });
  await assert.rejects(() => resolveAdapter({ projectRoot }), /adapter\.beads\.requiredDir must be a/);
});
