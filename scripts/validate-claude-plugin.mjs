#!/usr/bin/env node
import { readJson, pathExists } from "../src/lib/fs.mjs";
import { repoPath } from "../src/lib/paths.mjs";

const manifest = await readJson(repoPath(".claude-plugin", "plugin.json"));
for (const key of ["name", "version", "description", "skills", "agents", "hooks", "interface"]) {
  if (!(key in manifest)) {
    throw new Error(`missing .claude-plugin/plugin.json field ${key}`);
  }
}
for (const target of [
  repoPath(".claude-plugin", "hooks", "hooks.json"),
  repoPath(".claude-plugin", "agents", "agent-relay-orchestrator.md"),
  repoPath(".claude-plugin", "agents", "agent-relay-coder.md"),
  repoPath(".claude-plugin", "agents", "agent-relay-reviewer.md")
]) {
  if (!(await pathExists(target))) {
    throw new Error(`missing generated Claude plugin file: ${target}`);
  }
}
