import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { acquireLock } from "../src/lib/lock.mjs";
import { cleanupFixtures, fixtureDir } from "./helpers.mjs";

test.after(cleanupFixtures);

const lockModuleUrl = new URL("../src/lib/lock.mjs", import.meta.url).href;
const contenderScript = `
import { access } from "node:fs/promises";
import { acquireLock } from ${JSON.stringify(lockModuleUrl)};
async function waitForSignal(signalPath) {
  for (;;) {
    try {
      await access(signalPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
const lockPath = process.argv[1];
const owner = process.argv[2];
const startSignalPath = process.argv[3];
const releaseSignalPath = process.argv[4];
await waitForSignal(startSignalPath);
const lock = await acquireLock({ lockPath, owner });
process.send?.({ acquired: lock.acquired, currentLock: lock.currentLock ?? null, reason: lock.reason ?? null });
if (!lock.acquired) {
  process.exit(0);
}
await waitForSignal(releaseSignalPath);
await lock.release();
process.exit(0);
`;

async function waitForContenderResult(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
    };
    const finish = (callback) => (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    child.on("message", finish(resolve));
    child.on("error", finish(reject));
    child.on("exit", (code, signal) => {
      finish(reject)(new Error(`lock contender exited before reporting: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

async function spawnContender(lockPath, owner, startSignalPath, releaseSignalPath) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", contenderScript, lockPath, owner, startSignalPath, releaseSignalPath], {
    stdio: ["pipe", "ignore", "ignore", "ipc"]
  });
  const result = await waitForContenderResult(child);
  return { child, result };
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => child.once("exit", resolve));
}

test("acquireLock keeps the kernel lock after the flock helper exits, then releases for reacquire", { timeout: 10000 }, async () => {
  const root = await fixtureDir("agent-relay-lock-");
  const lockPath = path.join(root, "locks", "bead.lock.json");
  await mkdir(path.dirname(lockPath), { recursive: true });

  const first = await acquireLock({
    lockPath,
    owner: "run:1"
  });
  assert.equal(first.acquired, true);

  const blocked = await acquireLock({
    lockPath,
    owner: "run:2"
  });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.reason, "locked");
  assert.equal(blocked.currentLock.owner, "run:1");

  await first.release();

  const reacquired = await acquireLock({
    lockPath,
    owner: "run:3"
  });
  assert.equal(reacquired.acquired, true);
  await reacquired.release();
});

test("kernel flock yields exactly one multi-process owner across 24 contenders", { timeout: 15000 }, async () => {
  const root = await fixtureDir("agent-relay-lock-");
  const lockPath = path.join(root, "locks", "bead.lock.json");
  const startSignalPath = path.join(root, "start.signal");
  const releaseSignalPath = path.join(root, "release.signal");
  await mkdir(path.dirname(lockPath), { recursive: true });

  const contendersPromise = Promise.all(
    Array.from({ length: 24 }, (_, index) => spawnContender(lockPath, `run:${index}`, startSignalPath, releaseSignalPath))
  );
  await writeFile(startSignalPath, "go\n", "utf8");
  const contenders = await contendersPromise;
  const acquired = contenders.filter((contender) => contender.result.acquired);
  assert.equal(acquired.length, 1);
  const diskLock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(diskLock.owner, acquired[0].result.currentLock.owner);
  await writeFile(releaseSignalPath, "release\n", "utf8");
  for (const contender of contenders) {
    await waitForExit(contender.child);
  }
});

test("kernel flock releases on holder crash and allows reacquire", { timeout: 15000 }, async () => {
  const root = await fixtureDir("agent-relay-lock-");
  const lockPath = path.join(root, "locks", "bead.lock.json");
  const startSignalPath = path.join(root, "start.signal");
  const releaseSignalPath = path.join(root, "release.signal");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await access(path.dirname(lockPath));
  await writeFile(startSignalPath, "go\n", "utf8");

  const first = await spawnContender(lockPath, "run:first", startSignalPath, releaseSignalPath);
  assert.equal(first.result.acquired, true);
  first.child.kill("SIGKILL");
  await new Promise((resolve) => first.child.once("exit", resolve));

  const second = await acquireLock({
    lockPath,
    owner: "run:second"
  });
  assert.equal(second.acquired, true);
  const diskLock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(diskLock.owner, "run:second");
  await second.release();
});
