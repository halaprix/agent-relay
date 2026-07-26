import { parseFrontmatter, renderBody } from "./shared.mjs";

function renderRole(role) {
  const frontmatter = [
    "---",
    `name: ${role.name}`,
    `description: ${role.description}`,
    `model: ${role.agy.model}`,
    `effort: ${role.agy.effort}`,
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
  attributionAliases: ["agy"]
};
