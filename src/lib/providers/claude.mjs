import { parseFrontmatter, renderBody } from "./shared.mjs";

function renderRole(role, roleModel) {
  const frontmatter = [
    "---",
    `name: ${role.name}`,
    `description: ${role.description}`,
    `model: ${roleModel.model}`,
    `effort: ${roleModel.effort}`,
    `maxTurns: ${role.maxTurns}`,
    `isolation: ${role.isolation}`,
    "---"
  ].join("\n");
  return `${frontmatter}\n${renderBody(role)}\n`;
}

export default {
  name: "claude",
  extension: "md",
  renderRole,
  parseRole: parseFrontmatter,
  // The bundle shipped inside the plugin lives under a different directory than the
  // one a target project gets synced into — that asymmetry is exactly what the old
  // duplication across roles.mjs/supervisor.mjs hid.
  repoBundleDir: [".claude-plugin", "agents"],
  projectDir: [".claude", "agents"],
  attributionAliases: ["claude"],
  // Provider-owned per-role defaults, keyed by canonical role name (see ROLE_ORDER
  // in constants.mjs). A role source file may still override a single entry; see
  // resolveRoleModel in roles.mjs for the precedence rule.
  roleDefaults: {
    orchestrator: { model: "sonnet", effort: "high" },
    coder: { model: "sonnet", effort: "medium" },
    reviewer: { model: "sonnet", effort: "high" }
  }
};
