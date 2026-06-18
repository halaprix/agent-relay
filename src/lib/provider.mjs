import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function classifyProviderFailure(runResult) {
  const stderr = `${runResult.stderr || ""} ${runResult.stdout || ""}`.toLowerCase();
  if (runResult.timedOut) {
    return "checkpoint-and-handoff";
  }
  if (/quota|rate limit|429|authentication|unauthorized|forbidden/.test(stderr)) {
    return "handoff-immediate";
  }
  if (/timed out|timeout|econnreset|service unavailable|network/.test(stderr)) {
    return "handoff-after-retry";
  }
  if (runResult.signal === "SIGTERM" || /crash|segmentation|missing report/.test(stderr)) {
    return "checkpoint-and-handoff";
  }
  return "return-to-coder";
}

export function parseWorkerReport(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("worker report missing stdout");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        continue;
      }
    }
    throw new Error("worker report was not valid JSON");
  }
}

export async function runProviderCommand({
  providerName,
  command,
  args = [],
  cwd,
  env = {},
  timeoutMs
}) {
  const resolvedCommand = command.endsWith(".mjs") || command.endsWith(".js") ? process.execPath : command;
  const resolvedArgs =
    resolvedCommand === process.execPath && command !== process.execPath
      ? [command, ...args]
      : args;
  const captureDir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-capture-"));
  const stdoutPath = path.join(captureDir, "stdout.log");
  const stderrPath = path.join(captureDir, "stderr.log");
  return new Promise((resolve) => {
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd,
      env: {
        ...process.env,
        ...env,
        AGENT_RELAY_PROVIDER: providerName,
        AGENT_RELAY_STDOUT_FILE: stdoutPath,
        AGENT_RELAY_STDERR_FILE: stderrPath
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        providerName,
        code: 1,
        signal: null,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        timedOut
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      Promise.all([
        stdout ? Promise.resolve(stdout) : readFile(stdoutPath, "utf8").catch(() => ""),
        stderr ? Promise.resolve(stderr) : readFile(stderrPath, "utf8").catch(() => "")
      ]).then(([capturedStdout, capturedStderr]) =>
        resolve({
          providerName,
          code: code ?? 1,
          signal,
          stdout: capturedStdout,
          stderr: capturedStderr,
          timedOut
        })
      );
    });
  });
}
