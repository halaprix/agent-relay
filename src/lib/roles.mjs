import path from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { ensureDir, readJson } from "./fs.mjs";
import { repoPath } from "./paths.mjs";
import { findProvider, PROVIDERS } from "./providers/index.mjs";

export async function loadRoleSpecs() {
  const sourceDir = repoPath("roles", "source");
  const files = (await readdir(sourceDir)).filter((file) => file.endsWith(".json")).sort();
  const roles = [];
  for (const fileName of files) {
    roles.push(await readJson(path.join(sourceDir, fileName)));
  }
  return roles;
}

export function renderClaudeRole(role) {
  return findProvider("claude").renderRole(role);
}

export function renderCodexRole(role) {
  return findProvider("codex").renderRole(role);
}

export function renderAgyRole(role) {
  return findProvider("agy").renderRole(role);
}

export function normalizeRoleOutput(format, content) {
  const parsed = findProvider(format).parseRole(content);
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
  const targets = {};
  for (const provider of PROVIDERS) {
    targets[`${provider.name}Dir`] = repoPath(...provider.repoBundleDir);
  }
  return targets;
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
    const output = { role: role.name };
    for (const provider of PROVIDERS) {
      output[provider.name] = provider.renderRole(role);
    }
    outputs.push(output);
  }
  if (check) {
    for (const output of outputs) {
      for (const provider of PROVIDERS) {
        const dir = targets[`${provider.name}Dir`];
        await assertExactFileContent(path.join(dir, `${output.role}.${provider.extension}`), output[provider.name]);
      }
    }
    return outputs;
  }
  for (const provider of PROVIDERS) {
    await ensureDir(targets[`${provider.name}Dir`]);
  }
  for (const output of outputs) {
    for (const provider of PROVIDERS) {
      const dir = targets[`${provider.name}Dir`];
      await writeFile(path.join(dir, `${output.role}.${provider.extension}`), output[provider.name], "utf8");
    }
  }
  return outputs;
}

export async function writeRoleFiles() {
  return syncRoleBundles();
}
