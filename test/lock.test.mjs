import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { acquireLock } from "../src/lib/lock.mjs";

test("acquireLock rejects a fresh lock and recovers a stale lock", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-lock-"));
  const lockPath = path.join(root, "locks", "bead.lock.json");
  await mkdir(path.dirname(lockPath), { recursive: true });

  await writeFile(lockPath, `${JSON.stringify({
    token: "fresh",
    owner: "run:1",
    pid: 1,
    heartbeatAt: Date.now()
  }, null, 2)}\n`, "utf8");
  const blocked = await acquireLock({
    lockPath,
    owner: "run:2",
    staleMs: 5000,
    heartbeatMs: 50
  });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.currentLock.owner, "run:1");

  await writeFile(lockPath, `${JSON.stringify({
    token: "stale",
    owner: "run:3",
    pid: 3,
    heartbeatAt: Date.now() - 10000
  }, null, 2)}\n`, "utf8");
  const recovered = await acquireLock({
    lockPath,
    owner: "run:4",
    staleMs: 100,
    heartbeatMs: 50
  });
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.recoveredStale, true);
  await recovered.release();
});
