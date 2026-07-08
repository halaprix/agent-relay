import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { loadRoleSpecs, normalizeRoleOutput, renderAgyRole, renderClaudeRole, renderCodexRole, syncRoleBundles } from "../src/lib/roles.mjs";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-roles-"));
  const targets = {
    claudeDir: path.join(root, ".claude-plugin", "agents"),
    codexDir: path.join(root, ".codex", "agents"),
    agyDir: path.join(root, ".agents", "agents")
  };
  await mkdir(targets.claudeDir, { recursive: true });
  await mkdir(targets.codexDir, { recursive: true });
  await mkdir(targets.agyDir, { recursive: true });
  const outputs = await syncRoleBundles({ targets });
  const driftPath = path.join(targets.codexDir, `${outputs[0].role}.toml`);
  const original = await readFile(driftPath, "utf8");
  await writeFile(driftPath, `${original}\n# drift`, "utf8");
  await assert.rejects(() => syncRoleBundles({ check: true, targets }), /generated role drift detected/);
});
