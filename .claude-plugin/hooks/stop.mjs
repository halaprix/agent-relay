#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const input = await readFile(0, "utf8").catch(() => "{}");
const payload = JSON.parse(input || "{}");
const summary = payload.summary || "";

if (!/review|gate|human/i.test(summary)) {
  process.stdout.write(
    JSON.stringify({
      decision: "deny",
      reason: "agent-relay requires the stop summary to mention review, gates, or human handoff status"
    })
  );
  process.exit(2);
}

process.stdout.write(JSON.stringify({ decision: "allow" }));
