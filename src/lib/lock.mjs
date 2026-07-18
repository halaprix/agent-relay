import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { ensureDir, pathExists } from "./fs.mjs";

const FLOCK_COMMAND = "/usr/bin/flock";
const HOLDER_READY = "agent-relay-lock-ready";
const HOLDER_BLOCKED_EXIT_CODE = 42;
const HOLDER_FAILURE_EXIT_CODE = 70;

async function readLockFile(lockPath) {
  if (!(await pathExists(lockPath))) {
    return null;
  }
  try {
    const [contents, stats] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath)
    ]);
    const parsed = JSON.parse(contents);
    return {
      ...parsed,
      heartbeatAt: stats.mtimeMs
    };
  } catch {
    return null;
  }
}

async function writeLockMetadata(lockPath, lockRecord) {
  await writeFile(lockPath, `${JSON.stringify(lockRecord, null, 2)}\n`, "utf8");
}

async function waitForLockHolder(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const cleanup = () => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
    };
    const finish = (callback) => (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    const onResolve = finish(resolve);
    const onReject = finish(reject);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(`${HOLDER_READY}\n`)) {
        onResolve({ acquired: true, stdout, stderr });
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      onReject(error);
    });
    child.on("exit", (code, signal) => {
      if (code === HOLDER_BLOCKED_EXIT_CODE) {
        onResolve({ acquired: false, stdout, stderr, code, signal });
        return;
      }
      onReject(new Error(`flock holder failed with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr || stdout}`));
    });
  });
}

async function spawnLockHolder(lockPath) {
  if (process.platform !== "linux") {
    throw new Error("kernel-backed flock locks require Linux");
  }
  if (!(await pathExists(FLOCK_COMMAND))) {
    throw new Error("kernel-backed flock command is unavailable");
  }
  const child = spawn(FLOCK_COMMAND, [
    "-n",
    "-E",
    String(HOLDER_BLOCKED_EXIT_CODE),
    lockPath,
    "/bin/sh",
    "-c",
    `printf '${HOLDER_READY}\n'; cat >/dev/null`
  ], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const result = await waitForLockHolder(child);
  if (!result.acquired) {
    child.stdin?.end();
    return { acquired: false, child };
  }
  return { acquired: true, child };
}

export async function acquireLock({
  lockPath,
  owner
}) {
  await ensureDir(path.dirname(lockPath));
  const currentLock = {
    token: randomUUID(),
    owner,
    host: os.hostname(),
    pid: process.pid,
    heartbeatAt: Date.now()
  };
  const holder = await spawnLockHolder(lockPath);
  if (!holder.acquired) {
    return {
      acquired: false,
      recoveredStale: false,
      currentLock: await readLockFile(lockPath),
      reason: "locked"
    };
  }

  try {
    await writeLockMetadata(lockPath, currentLock);
  } catch (error) {
    holder.child.stdin?.end();
    throw error;
  }

  return {
    acquired: true,
    recoveredStale: false,
    currentLock,
    async release() {
      holder.child.stdin?.end();
      await new Promise((resolve) => {
        holder.child.once("exit", () => resolve());
        holder.child.once("close", () => resolve());
      });
    }
  };
}
