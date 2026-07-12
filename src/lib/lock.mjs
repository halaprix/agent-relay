import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { ensureDir, pathExists } from "./fs.mjs";

async function writeAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, value, "utf8");
  await rename(tmpPath, filePath);
}

async function readLockFile(lockPath) {
  if (!(await pathExists(lockPath))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function isHeartbeatStale(lockRecord, staleMs) {
  if (!lockRecord?.heartbeatAt) {
    return true;
  }
  return Date.now() - Number(lockRecord.heartbeatAt) > staleMs;
}

function isSameHost(lockRecord) {
  return lockRecord?.host === os.hostname();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function writeLockRecord(lockPath, lockRecord, token) {
  const diskLock = await readLockFile(lockPath);
  if (diskLock?.token !== token) {
    return false;
  }
  await writeAtomic(lockPath, `${JSON.stringify(lockRecord, null, 2)}\n`);
  return true;
}

function canTakeOver(lockRecord, staleMs) {
  if (!isHeartbeatStale(lockRecord, staleMs)) {
    return { allowed: false, reason: "heartbeat-fresh" };
  }
  if (!isSameHost(lockRecord)) {
    return { allowed: false, reason: "foreign-host" };
  }
  if (isProcessAlive(Number(lockRecord?.pid))) {
    return { allowed: false, reason: "owner-alive" };
  }
  return { allowed: true, reason: "owner-dead" };
}

async function attemptTakeover(lockPath, currentLock) {
  const takenOverPath = `${lockPath}.taken-over.${randomUUID()}`;
  try {
    await rename(lockPath, takenOverPath);
  } catch {
    return false;
  }
  const displaced = await readLockFile(takenOverPath);
  const displacedToken = displaced?.token || null;
  const expectedToken = currentLock?.token || null;
  if (expectedToken && displacedToken && displacedToken !== expectedToken) {
    await rename(takenOverPath, lockPath).catch(() => {});
    return false;
  }
  await rm(takenOverPath, { force: true }).catch(() => {});
  return true;
}

export async function acquireLock({
  lockPath,
  owner,
  staleMs = 30000,
  heartbeatMs = 500
}) {
  await ensureDir(path.dirname(lockPath));
  const token = randomUUID();
  const host = os.hostname();
  let recoveredStale = false;
  let currentLock = null;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      currentLock = {
        token,
        owner,
        host,
        pid: process.pid,
        heartbeatAt: Date.now()
      };
      await handle.writeFile(`${JSON.stringify(currentLock, null, 2)}\n`, "utf8");
      await handle.close();
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      currentLock = await readLockFile(lockPath);
      const takeover = canTakeOver(currentLock, staleMs);
      if (!takeover.allowed) {
        return {
          acquired: false,
          recoveredStale,
          currentLock,
          reason: takeover.reason
        };
      }
      const tookOver = await attemptTakeover(lockPath, currentLock);
      if (!tookOver) {
        continue;
      }
      recoveredStale = true;
    }
  }

  const heartbeat = setInterval(async () => {
    try {
      currentLock = {
        ...currentLock,
        heartbeatAt: Date.now()
      };
      const wrote = await writeLockRecord(lockPath, currentLock, token);
      if (!wrote) {
        clearInterval(heartbeat);
      }
    } catch {
      // Release handles cleanup; heartbeat is best-effort.
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    acquired: true,
    recoveredStale,
    currentLock,
    async release() {
      clearInterval(heartbeat);
      const diskLock = await readLockFile(lockPath);
      if (diskLock?.token === token) {
        await rm(lockPath, { force: true });
      }
    }
  };
}
