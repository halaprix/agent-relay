import { escapeTomlMultiline, parseTomlRole, renderBody } from "./shared.mjs";

function renderRole(role, roleModel) {
  const body = escapeTomlMultiline(renderBody(role));
  return [
    `name = "${role.name}"`,
    `description = "${role.description}"`,
    `model = "${roleModel.model}"`,
    `reasoning_effort = "${roleModel.effort}"`,
    `max_turns = ${role.maxTurns}`,
    "instructions = \"\"\"",
    body,
    "\"\"\"",
    ""
  ].join("\n");
}

export default {
  name: "codex",
  extension: "toml",
  renderRole,
  parseRole: parseTomlRole,
  repoBundleDir: [".codex", "agents"],
  projectDir: [".codex", "agents"],
  attributionAliases: ["codex"],
  // Provider-owned per-role defaults, keyed by canonical role name (see ROLE_ORDER
  // in constants.mjs). A role source file may still override a single entry; see
  // resolveRoleModel in roles.mjs for the precedence rule.
  roleDefaults: {
    orchestrator: { model: "gpt-5.4", effort: "high" },
    coder: { model: "gpt-5.4", effort: "medium" },
    reviewer: { model: "gpt-5.4", effort: "high" }
  }
};
