import path from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { ensureDir, readJson } from "./fs.mjs";
import { repoPath } from "./paths.mjs";

export async function loadRoleSpecs() {
  const sourceDir = repoPath("roles", "source");
  const files = (await readdir(sourceDir)).filter((file) => file.endsWith(".json")).sort();
  const roles = [];
  for (const fileName of files) {
    roles.push(await readJson(path.join(sourceDir, fileName)));
  }
  return roles;
}

function escapeTomlMultiline(value) {
  return value.replace(/"""/g, '\\"""');
}

function renderBody(role) {
  return [
    role.mission,
    "",
    "Operating rules:",
    ...role.rules.map((rule) => `- ${rule}`),
    "",
    "Report contract:",
    ...role.reportContract.map((rule) => `- ${rule}`)
  ].join("\n");
}

export function renderClaudeRole(role) {
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

export function renderCodexRole(role) {
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

export function renderAgyRole(role) {
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

function parseFrontmatter(markdown) {
  const lines = markdown.trim().split("\n");
  const data = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      break;
    }
    const [key, ...rest] = lines[index].split(":");
    data[key.trim()] = rest.join(":").trim();
  }
  return {
    frontmatter: data,
    body: lines.slice(index + 1).join("\n").trim()
  };
}

function parseTomlRole(toml) {
  const data = {};
  const lines = toml.trim().split("\n");
  let body = "";
  let collecting = false;
  for (const line of lines) {
    if (line.startsWith("instructions =")) {
      collecting = true;
      continue;
    }
    if (collecting) {
      if (line === '"""') {
        collecting = false;
        continue;
      }
      body += `${body ? "\n" : ""}${line}`;
      continue;
    }
    const match = line.match(/^([a-z_]+)\s*=\s*"?(.*?)"?$/);
    if (match) {
      data[match[1]] = match[2];
    }
  }
  return { frontmatter: data, body };
}

export function normalizeRoleOutput(format, content) {
  const parsed =
    format === "codex"
      ? parseTomlRole(content)
      : parseFrontmatter(content);
  const bodyLines = parsed.body.split("\n");
  const mission = bodyLines[0];
  const rulesIndex = bodyLines.indexOf("Operating rules:");
  const reportIndex = bodyLines.indexOf("Report contract:");
  return {
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    mission,
    rules: bodyLines
      .slice(rulesIndex + 1, reportIndex - 1)
      .filter(Boolean)
      .map((line) => line.replace(/^- /, "")),
    reportContract: bodyLines
      .slice(reportIndex + 1)
      .filter(Boolean)
      .map((line) => line.replace(/^- /, ""))
  };
}

function defaultRoleTargets() {
  return {
    claudeDir: repoPath(".claude-plugin", "agents"),
    codexDir: repoPath(".codex", "agents"),
    agyDir: repoPath(".agents", "agents")
  };
}

async function assertExactFileContent(filePath, expected) {
  const actual = await readFile(filePath, "utf8").catch(() => null);
  if (actual !== expected) {
    throw new Error(`generated role drift detected: ${filePath}`);
  }
}

export async function syncRoleBundles({ check = false, targets = defaultRoleTargets() } = {}) {
  const roles = await loadRoleSpecs();
  const outputs = [];
  for (const role of roles) {
    outputs.push({
      role: role.name,
      claude: renderClaudeRole(role),
      codex: renderCodexRole(role),
      agy: renderAgyRole(role)
    });
  }
  if (check) {
    for (const output of outputs) {
      await assertExactFileContent(path.join(targets.claudeDir, `${output.role}.md`), output.claude);
      await assertExactFileContent(path.join(targets.codexDir, `${output.role}.toml`), output.codex);
      await assertExactFileContent(path.join(targets.agyDir, `${output.role}.md`), output.agy);
    }
    return outputs;
  }
  await ensureDir(targets.claudeDir);
  await ensureDir(targets.codexDir);
  await ensureDir(targets.agyDir);
  for (const output of outputs) {
    await writeFile(path.join(targets.claudeDir, `${output.role}.md`), output.claude, "utf8");
    await writeFile(path.join(targets.codexDir, `${output.role}.toml`), output.codex, "utf8");
    await writeFile(path.join(targets.agyDir, `${output.role}.md`), output.agy, "utf8");
  }
  return outputs;
}

export async function writeRoleFiles() {
  return syncRoleBundles();
}
