import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Regression guard for the fixture-leak fix (bead agent-relay-6st.7): every
// test fixture must be allocated inside the shared session-scoped parent
// created by `fixtureDir()` in test/helpers.mjs, never directly against the
// bare tmpdir root. A live before/after count of `agent-relay-*` entries at
// the tmpdir root is NOT used here, because `node --test test/*.test.mjs`
// runs test files concurrently in separate processes: a sibling file's
// fixtures (and their eventual cleanup) can straddle whatever window this
// guard measures, so a live count is inherently racy and could pass or fail
// for reasons unrelated to a real regression. Instead this is a static
// check: only helpers.mjs's own `sessionRoot()` may call
// `mkdtemp(path.join(os.tmpdir(), ...))` directly; every other call site
// (in helpers.mjs or any test file) must go through `fixtureDir()`.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const directTmpdirMkdtemp = /mkdtemp\(\s*path\.join\(\s*os\.tmpdir\(\)/;

test("only the shared fixtureDir() allocator calls mkdtemp against the bare tmpdir root", async () => {
  const entries = await readdir(testDir, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".mjs") && entry.name !== "fixture-allocation.test.mjs"
    )
    .map((entry) => entry.name);
  assert.ok(files.includes("helpers.mjs"), "expected test/helpers.mjs to exist");

  const offenders = [];
  for (const file of files) {
    const source = await readFile(path.join(testDir, file), "utf8");
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!directTmpdirMkdtemp.test(line)) {
        return;
      }
      const isAllowedAllocator = file === "helpers.mjs" && line.includes("agent-relay-session-");
      if (!isAllowedAllocator) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `found mkdtemp(os.tmpdir()) call(s) bypassing fixtureDir():\n${offenders.join("\n")}`
  );
});
