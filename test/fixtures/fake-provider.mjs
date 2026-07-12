#!/usr/bin/env node
import { spawn } from "node:child_process";
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
const call = {
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  prompt
};
if (step.captureEnv) {
  call.env = {
    BEADS_DIR: process.env.BEADS_DIR ?? null,
    PATH: process.env.PATH ?? null
  };
}
store.calls.push(call);
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

if (step.absoluteWritePath) {
  try {
    await writeFile(step.absoluteWritePath, step.absoluteWriteContent || "escape\n", "utf8");
    call.absoluteWrite = { ok: true };
  } catch (error) {
    call.absoluteWrite = { ok: false, message: error.message };
  }
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

if (step.execAbsoluteCommand) {
  const commandArgs = step.execAbsoluteArgs || [];
  const result = await new Promise((resolve) => {
    try {
      const child = spawn(step.execAbsoluteCommand, commandArgs, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
      child.on("error", (error) => {
        resolve({ code: 1, signal: null, stdout, stderr: error.message });
      });
    } catch (error) {
      resolve({ code: 1, signal: null, stdout: "", stderr: error.message });
    }
  });
  call.absoluteCommand = result;
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  if (result.code !== 0) {
    await writeStderr(result.stderr || "absolute command failed\n");
    process.exit(result.code ?? 1);
  }
}

if (step.delayedWrite) {
  const delayedPath = step.delayedWrite.absolute
    ? step.delayedWrite.path
    : path.join(process.cwd(), step.delayedWrite.path);
  const delayMs = step.delayedWrite.delayMs || 250;
  const delayedContent = JSON.stringify(step.delayedWrite.content || "delayed\n");
  const delayedTarget = JSON.stringify(delayedPath);
  spawn(process.execPath, [
    "-e",
    `setTimeout(async()=>{const fs=require('node:fs/promises');await fs.writeFile(${delayedTarget}, ${delayedContent}, 'utf8');}, ${delayMs});`
  ], {
    detached: true,
    stdio: "ignore"
  }).unref();
}

await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");

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
