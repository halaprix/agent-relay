import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { ensureDir, pathExists } from "./fs.mjs";

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

async function createLockCandidate(lockPath, lockRecord) {
  const candidatePath = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
  await writeFile(candidatePath, `${JSON.stringify(lockRecord, null, 2)}\n`, "utf8");
  const handle = await open(candidatePath, "r+");
  return { candidatePath, handle };
}

async function publishCandidate(lockPath, candidatePath) {
  try {
    await link(candidatePath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function canTakeOver(lockRecord, staleMs) {
  if (!lockRecord) {
    return { allowed: true, reason: "missing-lock" };
  }
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

async function displaceStaleLock(lockPath, currentLock) {
  const displacedPath = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, displacedPath);
  } catch {
    return null;
  }
  const displaced = await readLockFile(displacedPath);
  const displacedToken = displaced?.token || null;
  const expectedToken = currentLock?.token || null;
  if (expectedToken && displacedToken && displacedToken !== expectedToken) {
    await rename(displacedPath, lockPath).catch(() => {});
    return null;
  }
  return displacedPath;
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
  const currentLock = {
    token,
    owner,
    host,
    pid: process.pid,
    heartbeatAt: Date.now()
  };
  const candidate = await createLockCandidate(lockPath, currentLock);
  let recoveredStale = false;
  let acquired = false;

  try {
    while (true) {
      if (await publishCandidate(lockPath, candidate.candidatePath)) {
        acquired = true;
        break;
      }
      const incumbentLock = await readLockFile(lockPath);
      const takeover = canTakeOver(incumbentLock, staleMs);
      if (!takeover.allowed) {
        await candidate.handle.close().catch(() => {});
        await rm(candidate.candidatePath, { force: true }).catch(() => {});
        return {
          acquired: false,
          recoveredStale,
          currentLock: incumbentLock,
          reason: takeover.reason
        };
      }
      const displacedPath = await displaceStaleLock(lockPath, incumbentLock);
      if (!displacedPath) {
        continue;
      }
      if (await publishCandidate(lockPath, candidate.candidatePath)) {
        recoveredStale = true;
        acquired = true;
        await rm(displacedPath, { force: true }).catch(() => {});
        break;
      }
      await rm(displacedPath, { force: true }).catch(() => {});
    }
  } catch (error) {
    await candidate.handle.close().catch(() => {});
    await rm(candidate.candidatePath, { force: true }).catch(() => {});
    throw error;
  }

  if (!acquired) {
    await candidate.handle.close().catch(() => {});
    await rm(candidate.candidatePath, { force: true }).catch(() => {});
    throw new Error(`failed to acquire lock ${lockPath}`);
  }

  await rm(candidate.candidatePath, { force: true }).catch(() => {});

  const heartbeat = setInterval(async () => {
    try {
      const diskLock = await readLockFile(lockPath);
      if (diskLock?.token !== token) {
        clearInterval(heartbeat);
        return;
      }
      const now = new Date();
      await candidate.handle.utimes(now, now);
      currentLock.heartbeatAt = now.getTime();
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
      try {
        const diskLock = await readLockFile(lockPath);
        if (diskLock?.token === token) {
          await rm(lockPath, { force: true });
        }
      } finally {
        await candidate.handle.close().catch(() => {});
      }
    }
  };
}
