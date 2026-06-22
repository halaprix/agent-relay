#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_GIT_STATUSES;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const next = state.statuses.shift() ?? "";
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
if (process.env.AGENT_RELAY_STDOUT_FILE) {
  writeFileSync(process.env.AGENT_RELAY_STDOUT_FILE, `${next}\n`, "utf8");
} else {
  process.stdout.write(`${next}\n`);
}
