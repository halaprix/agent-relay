import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { ensureDir, pathExists } from "./fs.mjs";

const FLOCK_COMMAND = "/usr/bin/flock";
const HOLDER_BLOCKED_EXIT_CODE = 42;
const HOLDER_FD = 3;

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

async function waitForLockAttempt(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const cleanup = () => {
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
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      onReject(error);
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        onResolve({ acquired: true, stderr, code, signal });
        return;
      }
      if (code === HOLDER_BLOCKED_EXIT_CODE) {
        onResolve({ acquired: false, stderr, code, signal });
        return;
      }
      onReject(new Error(`flock helper failed with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr}`));
    });
  });
}

async function acquireKernelLock(lockPath) {
  if (process.platform !== "linux") {
    throw new Error("kernel-backed flock locks require Linux");
  }
  if (!(await pathExists(FLOCK_COMMAND))) {
    throw new Error("kernel-backed flock command is unavailable");
  }
  const fileHandle = await open(lockPath, "a+");
  const child = spawn(FLOCK_COMMAND, [
    "-x",
    "-n",
    "-E",
    String(HOLDER_BLOCKED_EXIT_CODE),
    String(HOLDER_FD)
  ], {
    stdio: ["ignore", "ignore", "pipe", fileHandle.fd]
  });
  try {
    const result = await waitForLockAttempt(child);
    if (!result.acquired) {
      await fileHandle.close();
      return { acquired: false, currentLock: await readLockFile(lockPath) };
    }
    return { acquired: true, fileHandle };
  } catch (error) {
    await fileHandle.close().catch(() => {});
    throw error;
  }
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
  const kernelLock = await acquireKernelLock(lockPath);
  if (!kernelLock.acquired) {
    return {
      acquired: false,
      recoveredStale: false,
      currentLock: kernelLock.currentLock,
      reason: "locked"
    };
  }

  try {
    await writeLockMetadata(lockPath, currentLock);
  } catch (error) {
    await kernelLock.fileHandle.close().catch(() => {});
    throw error;
  }

  let released = false;
  return {
    acquired: true,
    recoveredStale: false,
    currentLock,
    async release() {
      if (released) {
        return;
      }
      released = true;
      await kernelLock.fileHandle.close();
    }
  };
}
