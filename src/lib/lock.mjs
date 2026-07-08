import { randomUUID } from "node:crypto";
import path from "node:path";
import { open, readFile, rm, rename, writeFile } from "node:fs/promises";
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

function isStale(lockRecord, staleMs) {
  if (!lockRecord?.heartbeatAt) {
    return true;
  }
  return Date.now() - Number(lockRecord.heartbeatAt) > staleMs;
}

export async function acquireLock({
  lockPath,
  owner,
  staleMs = 5000,
  heartbeatMs = 500
}) {
  await ensureDir(path.dirname(lockPath));
  const token = randomUUID();
  let recoveredStale = false;
  let acquired = false;
  let currentLock = null;
  while (!acquired) {
    try {
      const handle = await open(lockPath, "wx");
      currentLock = {
        token,
        owner,
        pid: process.pid,
        heartbeatAt: Date.now()
      };
      await handle.writeFile(`${JSON.stringify(currentLock, null, 2)}\n`, "utf8");
      await handle.close();
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      currentLock = await readLockFile(lockPath);
      if (!isStale(currentLock, staleMs)) {
        return {
          acquired: false,
          recoveredStale,
          currentLock
        };
      }
      recoveredStale = true;
      await rm(lockPath, { force: true });
    }
  }

  const heartbeat = setInterval(async () => {
    try {
      currentLock = {
        ...currentLock,
        heartbeatAt: Date.now()
      };
      await writeAtomic(lockPath, `${JSON.stringify(currentLock, null, 2)}\n`);
    } catch {
      // Release paths handle cleanup; heartbeat is best-effort.
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
