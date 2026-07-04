#!/usr/bin/env node
import { readJson, pathExists } from "../src/lib/fs.mjs";
import { repoPath } from "../src/lib/paths.mjs";

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
}

const manifest = await readJson(repoPath(".codex-plugin", "plugin.json"));
for (const field of ["name", "version", "description", "author", "interface"]) {
  if (!(field in manifest)) {
    throw new Error(`missing .codex-plugin/plugin.json field ${field}`);
  }
}
requireString(manifest.name, "name");
requireString(manifest.version, "version");
requireString(manifest.description, "description");
requireString(manifest.author?.name, "author.name");
requireString(manifest.interface?.displayName, "interface.displayName");
requireString(manifest.interface?.shortDescription, "interface.shortDescription");
requireString(manifest.interface?.longDescription, "interface.longDescription");
requireString(manifest.interface?.developerName, "interface.developerName");
requireString(manifest.interface?.category, "interface.category");
if (!Array.isArray(manifest.interface?.capabilities) || manifest.interface.capabilities.length === 0) {
  throw new Error("interface.capabilities must be a non-empty array");
}
if (!(await pathExists(repoPath(manifest.skills.replace(/^\.\//, ""))))) {
  throw new Error(`missing skills path ${manifest.skills}`);
}
