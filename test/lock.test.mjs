import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { acquireLock } from "../src/lib/lock.mjs";

test("acquireLock rejects a fresh lock and recovers a stale lock", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-lock-"));
  const lockPath = path.join(root, "locks", "bead.lock.json");
  await mkdir(path.dirname(lockPath), { recursive: true });

  await writeFile(lockPath, `${JSON.stringify({
    token: "fresh",
    owner: "run:1",
    host: os.hostname(),
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
    host: os.hostname(),
    pid: 999999,
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

test("acquireLock keeps live stale owners, allows one dead-owner takeover, and stops stale heartbeats from overwriting replacements", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-lock-"));
  const lockPath = path.join(root, "locks", "bead.lock.json");
  await mkdir(path.dirname(lockPath), { recursive: true });

  await writeFile(lockPath, `${JSON.stringify({
    token: "live-stale",
    owner: "run:live",
    host: os.hostname(),
    pid: process.pid,
    heartbeatAt: Date.now() - 10000
  }, null, 2)}\n`, "utf8");
  const blocked = await acquireLock({
    lockPath,
    owner: "run:blocked",
    staleMs: 100,
    heartbeatMs: 50
  });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.reason, "owner-alive");

  await writeFile(lockPath, `${JSON.stringify({
    token: "dead-owner",
    owner: "run:dead",
    host: os.hostname(),
    pid: 999998,
    heartbeatAt: Date.now() - 10000
  }, null, 2)}\n`, "utf8");
  const [first, second] = await Promise.all([
    acquireLock({ lockPath, owner: "run:first", staleMs: 100, heartbeatMs: 25 }),
    acquireLock({ lockPath, owner: "run:second", staleMs: 100, heartbeatMs: 25 })
  ]);
  const acquired = [first, second].filter((attempt) => attempt.acquired);
  assert.equal(acquired.length, 1);
  assert.equal([first, second].some((attempt) => attempt.recoveredStale), true);

  const replacedToken = acquired[0].currentLock.token;
  await writeFile(lockPath, `${JSON.stringify({
    token: "replacement",
    owner: "run:replacement",
    host: os.hostname(),
    pid: 999997,
    heartbeatAt: Date.now()
  }, null, 2)}\n`, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const finalLock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(finalLock.token, "replacement");
  assert.notEqual(finalLock.token, replacedToken);

  await Promise.all([first.release?.(), second.release?.()]);
});
