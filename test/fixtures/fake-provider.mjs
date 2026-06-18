#!/usr/bin/env node
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const storePath = process.env.FAKE_PROVIDER_STORE;
const stdoutFile = process.env.AGENT_RELAY_STDOUT_FILE;
const stderrFile = process.env.AGENT_RELAY_STDERR_FILE;
const store = JSON.parse(await readFile(storePath, "utf8"));
const step = store.steps.shift() || { type: "success", report: { status: "success", summary: "ok", commandsAttempted: [], changedPaths: [], artifacts: [] } };
const promptPath = process.argv.slice(2).at(-1);
let prompt = null;
if (promptPath) {
  prompt = await readFile(promptPath, "utf8").catch(() => null);
}
store.calls.push({
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  prompt
});
await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");

async function writeStdout(text) {
  if (stdoutFile) {
    await writeFile(stdoutFile, text, "utf8");
    return;
  }
  process.stdout.write(text);
}

async function writeStderr(text) {
  if (stderrFile) {
    await writeFile(stderrFile, text, "utf8");
    return;
  }
  process.stderr.write(text);
}

for (const change of step.writes || []) {
  const filePath = path.join(process.cwd(), change.path);
  await writeFile(filePath, change.content, "utf8");
}

if (step.gitDrift && process.env.FAKE_GIT_STORE) {
  const gitStore = JSON.parse(await readFile(process.env.FAKE_GIT_STORE, "utf8"));
  const worktree = gitStore.worktrees[process.cwd()];
  if (worktree) {
    if (step.gitDrift.head) {
      worktree.head = step.gitDrift.head;
    }
    if (step.gitDrift.branch) {
      worktree.branch = step.gitDrift.branch;
    }
  }
  await writeFile(process.env.FAKE_GIT_STORE, `${JSON.stringify(gitStore, null, 2)}\n`, "utf8");
}

if (step.type === "timeout") {
  await new Promise((resolve) => setTimeout(resolve, step.sleepMs || 250));
  process.exit(0);
}

if (step.type === "crash") {
  process.exit(2);
}

if (step.type === "malformed") {
  await writeStdout(step.stdout || "not json\n");
  process.exit(step.exitCode ?? 0);
}

if (step.type === "quota" || step.type === "auth" || step.type === "service" || step.type === "failure") {
  await writeStderr(step.stderr || `${step.type} failure\n`);
  process.exit(step.exitCode ?? 1);
}

await writeStdout(`${JSON.stringify(step.report)}\n`);
