import test from "node:test";
import assert from "node:assert/strict";
import { loadRoleSpecs, normalizeRoleOutput, renderAgyRole, renderClaudeRole, renderCodexRole } from "../src/lib/roles.mjs";

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
