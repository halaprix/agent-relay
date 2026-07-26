import { parseFrontmatter, renderBody } from "./shared.mjs";

function renderRole(role) {
  const frontmatter = [
    "---",
    `name: ${role.name}`,
    `description: ${role.description}`,
    `model: ${role.claude.model}`,
    `effort: ${role.claude.effort}`,
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
  attributionAliases: ["claude"]
};
