import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import {
  assertRoleDefaultsComplete,
  loadRoleSpecs,
  normalizeRoleOutput,
  renderAgyRole,
  renderClaudeRole,
  renderCodexRole,
  resolveRoleModel
} from "../src/lib/roles.mjs";
import { findProvider } from "../src/lib/providers/index.mjs";
import { createRepoFixture } from "./helpers.mjs";

test("generated role formats normalize back to the canonical body", async () => {
  const roles = await loadRoleSpecs();
  assert.equal(roles.length, 3);
  for (const role of roles) {
    const expected = {
      name: role.name,
      description: role.description,
      mission: role.mission,
      rules: role.rules,
      reportContract: role.reportContract
    };
    assert.deepEqual(normalizeRoleOutput("claude", renderClaudeRole(role)), expected);
    assert.deepEqual(normalizeRoleOutput("codex", renderCodexRole(role)), expected);
    assert.deepEqual(normalizeRoleOutput("agy", renderAgyRole(role)), expected);
  }
});

test("syncRoleBundles --check fails on tracked drift", async () => {
  const repoRoot = await createRepoFixture();
  const roles = await loadRoleSpecs();
  const driftPath = path.join(repoRoot, ".codex", "agents", `${roles[0].name}.toml`);
  const original = await readFile(driftPath, "utf8");
  await writeFile(driftPath, `${original}\n# drift`, "utf8");
  const run = spawnSync(process.execPath, ["scripts/sync-roles.mjs", "--check"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /generated role drift detected/);
});

test("a role source override wins over the provider manifest default", async () => {
  const provider = findProvider("claude");
  const [role] = await loadRoleSpecs();
  const overriddenRole = { ...role, claude: { model: "opus", effort: "low" } };
  assert.deepEqual(resolveRoleModel(provider, overriddenRole), { model: "opus", effort: "low" });
  // Sanity check: without the override, the manifest default applies instead.
  assert.notDeepEqual(resolveRoleModel(provider, role), { model: "opus", effort: "low" });
});

test("resolveRoleModel fails loudly when a provider manifest is missing roleDefaults for a role", async () => {
  const [role] = await loadRoleSpecs();
  const incompleteProvider = { name: "test-provider", roleDefaults: {} };
  assert.throws(
    () => resolveRoleModel(incompleteProvider, role),
    /provider "test-provider" is missing roleDefaults for role "coder"/
  );
});

test("assertRoleDefaultsComplete fails loudly at sync time for a provider missing any canonical role", () => {
  const incompleteProvider = {
    name: "test-provider",
    roleDefaults: { orchestrator: { model: "x", effort: "medium" }, coder: { model: "x", effort: "medium" } }
  };
  assert.throws(
    () => assertRoleDefaultsComplete(incompleteProvider),
    /provider "test-provider" is missing roleDefaults for role "reviewer"/
  );
});
