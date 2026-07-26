import { escapeTomlMultiline, parseTomlRole, renderBody } from "./shared.mjs";

function renderRole(role) {
  const body = escapeTomlMultiline(renderBody(role));
  return [
    `name = "${role.name}"`,
    `description = "${role.description}"`,
    `model = "${role.codex.model}"`,
    `reasoning_effort = "${role.codex.effort}"`,
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
  attributionAliases: ["codex"]
};
