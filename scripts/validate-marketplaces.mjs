#!/usr/bin/env node
import { readJson } from "../src/lib/fs.mjs";
import { repoPath } from "../src/lib/paths.mjs";

for (const target of [repoPath(".codex-plugin", "marketplace.json"), repoPath(".claude-plugin", "marketplace.json")]) {
  const marketplace = await readJson(target);
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    throw new Error(`invalid marketplace entries in ${target}`);
  }
}
