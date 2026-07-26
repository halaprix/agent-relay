import { parseFrontmatter, renderBody } from "./shared.mjs";

function renderRole(role, roleModel) {
  const frontmatter = [
    "---",
    `name: ${role.name}`,
    `description: ${role.description}`,
    `model: ${roleModel.model}`,
    `effort: ${roleModel.effort}`,
    "---"
  ].join("\n");
  return `${frontmatter}\n${renderBody(role)}\n`;
}

export default {
  name: "agy",
  extension: "md",
  renderRole,
  parseRole: parseFrontmatter,
  repoBundleDir: [".agents", "agents"],
  projectDir: [".agents", "agents"],
  attributionAliases: ["agy"],
  // Provider-owned per-role defaults, keyed by canonical role name (see ROLE_ORDER
  // in constants.mjs). A role source file may still override a single entry; see
  // resolveRoleModel in roles.mjs for the precedence rule.
  roleDefaults: {
    orchestrator: { model: "default", effort: "high" },
    coder: { model: "default", effort: "medium" },
    reviewer: { model: "default", effort: "high" }
  }
};
