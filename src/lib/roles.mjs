import path from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { ensureDir, readJson } from "./fs.mjs";
import { repoPath } from "./paths.mjs";
import { findProvider, PROVIDERS } from "./providers/index.mjs";
import { ROLE_ORDER } from "./constants.mjs";

export async function loadRoleSpecs() {
  const sourceDir = repoPath("roles", "source");
  const files = (await readdir(sourceDir)).filter((file) => file.endsWith(".json")).sort();
  const roles = [];
  for (const fileName of files) {
    const role = await readJson(path.join(sourceDir, fileName));
    // The role's canonical key (matching ROLE_ORDER) is derived from its file name
    // rather than stored in the JSON body, since it is identity, not role content.
    role.roleKey = path.basename(fileName, ".json");
    roles.push(role);
  }
  return roles;
}

// Resolution order for a role's per-provider model/effort: a role source file's own
// optional provider-named block (e.g. role.claude) WINS when present; otherwise the
// provider manifest's roleDefaults[roleKey] applies. This lets an unusual role pin a
// model without moving the provider's baseline for every other role.
export function resolveRoleModel(provider, role) {
  const override = role[provider.name];
  if (override) {
    return override;
  }
  const fallback = provider.roleDefaults?.[role.roleKey];
  if (!fallback) {
    throw new Error(`provider "${provider.name}" is missing roleDefaults for role "${role.roleKey}"`);
  }
  return fallback;
}

// Fails loudly, before anything is rendered, if a provider manifest's roleDefaults
// does not cover every canonical role in ROLE_ORDER.
export function assertRoleDefaultsComplete(provider) {
  for (const roleKey of ROLE_ORDER) {
    if (!provider.roleDefaults?.[roleKey]) {
      throw new Error(`provider "${provider.name}" is missing roleDefaults for role "${roleKey}"`);
    }
  }
}

export function renderClaudeRole(role) {
  const provider = findProvider("claude");
  return provider.renderRole(role, resolveRoleModel(provider, role));
}

export function renderCodexRole(role) {
  const provider = findProvider("codex");
  return provider.renderRole(role, resolveRoleModel(provider, role));
}

export function renderAgyRole(role) {
  const provider = findProvider("agy");
  return provider.renderRole(role, resolveRoleModel(provider, role));
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
  for (const provider of PROVIDERS) {
    assertRoleDefaultsComplete(provider);
  }
  const roles = await loadRoleSpecs();
  const outputs = [];
  for (const role of roles) {
    const output = { role: role.name };
    for (const provider of PROVIDERS) {
      output[provider.name] = provider.renderRole(role, resolveRoleModel(provider, role));
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
