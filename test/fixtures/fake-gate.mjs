#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const stdoutFile = process.env.AGENT_RELAY_STDOUT_FILE;
const stderrFile = process.env.AGENT_RELAY_STDERR_FILE;

async function out(text) {
  if (stdoutFile) {
    await writeFile(stdoutFile, text, "utf8");
    return;
  }
  process.stdout.write(text);
}

async function err(text) {
  if (stderrFile) {
    await writeFile(stderrFile, text, "utf8");
    return;
  }
  process.stderr.write(text);
}

if (process.env.FAKE_GATE_STORE) {
  const store = JSON.parse(await readFile(process.env.FAKE_GATE_STORE, "utf8"));
  const next = store.steps.shift() || { ok: true };
  await writeFile(process.env.FAKE_GATE_STORE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  if (!next.ok) {
    await err("gate failed\n");
    process.exit(1);
  }
  await out("gate passed\n");
  process.exit(0);
}

if (process.env.FAKE_GATE_FAIL === "1") {
  await err("gate failed\n");
  process.exit(1);
}

await out("gate passed\n");
