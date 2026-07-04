#!/usr/bin/env node
import { scanPrivacy } from "../src/lib/guardrails.mjs";
import { repoPath } from "../src/lib/paths.mjs";

const findings = await scanPrivacy(repoPath());
if (findings.length > 0) {
  process.stderr.write(`${JSON.stringify(findings, null, 2)}\n`);
  process.exit(1);
}
