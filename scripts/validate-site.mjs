#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { repoPath } from "../src/lib/paths.mjs";

const indexPath = repoPath("site", "index.html");
const html = await readFile(indexPath, "utf8");
const required = ["Agent Relay", "Beads", "Workflow", "Safety model", "Setup"];
const missing = required.filter((needle) => !html.includes(needle));
if (missing.length > 0) {
  process.stderr.write(`Missing required site sections: ${missing.join(", ")}\n`);
  process.exit(1);
}
