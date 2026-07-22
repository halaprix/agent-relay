import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { loadRoleSpecs, normalizeRoleOutput, renderAgyRole, renderClaudeRole, renderCodexRole } from "../src/lib/roles.mjs";
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
