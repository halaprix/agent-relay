#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { listFilesRecursive, pathExists } from "../src/lib/fs.mjs";
import { repoPath } from "../src/lib/paths.mjs";

const files = (await listFilesRecursive(repoPath())).filter((filePath) => /\.(md|html|json)$/i.test(filePath));
const missing = [];
for (const filePath of files) {
  const text = await readFile(filePath, "utf8");
  const matches = text.matchAll(/\[[^\]]+\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/g);
  for (const match of matches) {
    const target = match[1].split(":")[0];
    if (!target.startsWith("./") && !target.startsWith("../")) {
      continue;
    }
    const resolved = path.resolve(path.dirname(filePath), target);
    if (!(await pathExists(resolved))) {
      missing.push({ file: path.relative(repoPath(), filePath), target });
    }
  }
}
if (missing.length > 0) {
  process.stderr.write(`${JSON.stringify(missing, null, 2)}\n`);
  process.exit(1);
}
