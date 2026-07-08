#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { PROTECTED_COMMAND_PATTERNS } from "../../src/lib/constants.mjs";

const input = await readFile(0, "utf8").catch(() => "{}");
const payload = JSON.parse(input || "{}");
const commandText = [
  payload.tool_name,
  payload.tool_input?.command,
  payload.tool_input?.cmd
].filter(Boolean).join(" ");

const blocked = PROTECTED_COMMAND_PATTERNS.find((pattern) => pattern.test(commandText));
if (blocked) {
  process.stdout.write(
    JSON.stringify({
      decision: "deny",
      reason: `blocked by agent-relay hook: ${blocked.source}`
    })
  );
  process.exit(2);
}

process.stdout.write(JSON.stringify({ decision: "allow" }));
