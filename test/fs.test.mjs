import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { pathExists, withTempDir } from "../src/lib/fs.mjs";

async function countTmpEntriesWithPrefix(prefix) {
  const entries = await readdir(os.tmpdir());
  return entries.filter((entry) => entry.startsWith(prefix)).length;
}

test("withTempDir creates a dir, passes it to fn, removes it afterward, and returns fn's value", async () => {
  const before = await countTmpEntriesWithPrefix("agent-relay-with-temp-dir-test-");
  let capturedDir = null;
  const value = await withTempDir("agent-relay-with-temp-dir-test-", async (dir) => {
    capturedDir = dir;
    assert.equal(await pathExists(dir), true);
    return "fn-result";
  });
  assert.equal(value, "fn-result");
  assert.equal(await pathExists(capturedDir), false);
  const after = await countTmpEntriesWithPrefix("agent-relay-with-temp-dir-test-");
  assert.equal(after, before);
});

test("withTempDir removes the directory when fn throws and propagates the original error unchanged", async () => {
  const before = await countTmpEntriesWithPrefix("agent-relay-with-temp-dir-test-");
  let capturedDir = null;
  const originalError = new Error("boom from fn");
  await assert.rejects(
    () =>
      withTempDir("agent-relay-with-temp-dir-test-", async (dir) => {
        capturedDir = dir;
        throw originalError;
      }),
    (error) => error === originalError
  );
  assert.equal(await pathExists(capturedDir), false);
  const after = await countTmpEntriesWithPrefix("agent-relay-with-temp-dir-test-");
  assert.equal(after, before);
});
