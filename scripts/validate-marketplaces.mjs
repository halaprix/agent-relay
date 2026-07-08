#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../src/lib/fs.mjs";
import { repoPath } from "../src/lib/paths.mjs";
import { pathExists } from "../src/lib/fs.mjs";

export const MARKETPLACE_ROOT = repoPath("plugins");

function expectedManifestPath(marketplacePath, pluginRoot) {
  const manifestDir = marketplacePath.includes(".codex-plugin")
    ? ".codex-plugin"
    : ".claude-plugin";
  return path.join(pluginRoot, manifestDir, "plugin.json");
}

export async function validateMarketplaceFile(target) {
  const marketplace = await readJson(target);
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    throw new Error(`invalid marketplace entries in ${target}`);
  }
  const validated = [];
  for (const plugin of marketplace.plugins) {
    const sourcePath = plugin?.source?.path;
    if (plugin?.source?.source !== "local" || typeof sourcePath !== "string" || sourcePath.trim() === "") {
      throw new Error(`invalid local source for marketplace plugin ${plugin?.name || "<unknown>"} in ${target}`);
    }
    const resolved = path.resolve(path.dirname(target), sourcePath);
    const expected = path.join(MARKETPLACE_ROOT, plugin.name);
    if (resolved !== expected) {
      throw new Error(`marketplace plugin ${plugin.name} must resolve to ${expected}`);
    }
    if (!(await pathExists(resolved))) {
      throw new Error(`missing marketplace plugin target ${resolved}`);
    }
    const relative = path.relative(MARKETPLACE_ROOT, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`marketplace plugin ${plugin.name} resolved outside ${MARKETPLACE_ROOT}`);
    }
    const manifestPath = expectedManifestPath(target, resolved);
    if (!(await pathExists(manifestPath))) {
      throw new Error(`missing plugin manifest ${manifestPath}`);
    }
    validated.push({ name: plugin.name, target: resolved, manifestPath });
  }
  return validated;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  for (const target of [repoPath(".codex-plugin", "marketplace.json"), repoPath(".claude-plugin", "marketplace.json")]) {
    await validateMarketplaceFile(target);
  }
}
