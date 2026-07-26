import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { epicIdFor, listBeadChildren, storePathMatches, verifyBeadsStore } from "../src/lib/beads.mjs";
import { loadAdapter } from "../src/lib/adapter.mjs";
import { beadsDirFor, cleanupFixtures, createFakeBdStore } from "./helpers.mjs";
import { repoPath } from "../src/lib/paths.mjs";

test.after(cleanupFixtures);

const projectRoot = "/tmp/agent-relay-beads-fixture-project";
const projectBeadsDir = beadsDirFor(projectRoot);

test("verifyBeadsStore validates array-backed Beads payloads, acceptance_criteria, comments, and claim", async () => {
  const { adapter } = await loadAdapter("example-app");
  const storePath = await createFakeBdStore({
    projectRoot,
    comments: {
      "example-app-123": [{ text: "{\"kind\":\"note\",\"body\":\"checkpoint\"}" }]
    }
  });
  const result = verifyBeadsStore({
    adapter,
    beadId: "example-app-123",
    beadsDir: projectBeadsDir,
    env: {
      BEADS_DIR: projectBeadsDir,
      AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
      FAKE_BD_STORE: storePath,
      PATH: process.env.PATH
    }
  });
  assert.equal(result.store, projectBeadsDir);
  assert.equal(result.bead.id, "example-app-123");
  assert.equal(result.bead.acceptance_criteria.includes("delivery pauses safely"), true);
  assert.equal(Array.isArray(result.comments), true);
  assert.equal(result.claim.claimed, true);
}, { signal: AbortSignal.timeout(5000) });

test("runBd does not leak its capture temp dir on success or failure", async () => {
  const { adapter } = await loadAdapter("example-app");
  const storePath = await createFakeBdStore({ projectRoot });
  // fake-bd appends every capture dir it is handed here, so cleanup is asserted on
  // those exact paths. Counting `agent-relay-bd-capture-*` in tmpdir would be racy:
  // the prefix has no per-call discriminator and `node --test` runs test files
  // concurrently, so a sibling file's in-flight bd call lands in the count.
  const reportPath = path.join(path.dirname(storePath), "capture-report.json");
  const env = {
    BEADS_DIR: projectBeadsDir,
    AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
    FAKE_BD_STORE: storePath,
    FAKE_BD_CAPTURE_REPORT: reportPath,
    PATH: process.env.PATH
  };
  const reportedDirs = async () => JSON.parse(await readFile(reportPath, "utf8"));

  const children = listBeadChildren({ env, beadId: "example-app-123", beadsDir: projectBeadsDir });
  assert.deepEqual(children, []);
  const afterSuccess = await reportedDirs();
  assert.ok(afterSuccess.length >= 1, "fake-bd reported no capture dir on the success path");
  for (const dir of afterSuccess) {
    assert.equal(existsSync(dir), false, `leaked ${dir}`);
  }

  assert.throws(
    () =>
      verifyBeadsStore({
        adapter,
        beadId: "example-app-missing",
        beadsDir: projectBeadsDir,
        env
      }),
    /bd show failed/
  );
  const afterFailure = await reportedDirs();
  assert.ok(
    afterFailure.length > afterSuccess.length,
    "the failing bd call did not report a capture dir"
  );
  for (const dir of afterFailure) {
    assert.equal(existsSync(dir), false, `leaked ${dir}`);
  }
});

test("epicIdFor reduces a dotted bead id to its epic", () => {
  assert.equal(epicIdFor("agent-relay-n95"), "agent-relay-n95");
  assert.equal(epicIdFor("agent-relay-n95.1"), "agent-relay-n95");
  assert.equal(epicIdFor("agent-relay-n95.1.2"), "agent-relay-n95");
  assert.equal(epicIdFor(""), "");
});

test("listBeadChildren reports children, emptiness, and an unreadable store distinctly", async () => {
  const storePath = await createFakeBdStore({
    projectRoot,
    children: {
      "example-app-100": [
        { id: "example-app-100.1", title: "First slice", status: "open" },
        { id: "example-app-100.2", title: "Second slice", status: "closed" }
      ]
    }
  });
  const env = {
    AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
    FAKE_BD_STORE: storePath,
    PATH: process.env.PATH
  };

  const children = listBeadChildren({ env, beadId: "example-app-100" });
  assert.deepEqual(children.map((child) => child.id), ["example-app-100.1", "example-app-100.2"]);
  assert.deepEqual(listBeadChildren({ env, beadId: "example-app-123" }), []);

  // An unreadable store is unknown, not childless: enforcement must not run on a guess.
  const broken = listBeadChildren({
    env: { ...env, AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "does-not-exist.mjs") },
    beadId: "example-app-100"
  });
  assert.equal(broken, null);
});

test("storePathMatches accepts the embedded database inside the project store", () => {
  assert.equal(storePathMatches(projectBeadsDir, projectBeadsDir), true);
  assert.equal(storePathMatches(path.join(projectBeadsDir, "embeddeddolt"), projectBeadsDir), true);
  assert.equal(storePathMatches("/home/someone/.global-beads", projectBeadsDir), false);
});

test("verifyBeadsStore uses the project store even when a global BEADS_DIR is inherited", async () => {
  const { adapter } = await loadAdapter("example-app");
  const storePath = await createFakeBdStore({ projectRoot });
  const result = verifyBeadsStore({
    adapter,
    beadId: "example-app-123",
    beadsDir: projectBeadsDir,
    env: {
      BEADS_DIR: "/home/someone/.global-beads",
      AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
      FAKE_BD_STORE: storePath,
      PATH: process.env.PATH
    }
  });
  assert.equal(result.store, projectBeadsDir);
});

test("verifyBeadsStore fails on wrong store", async () => {
  const { adapter } = await loadAdapter("example-app");
  const storePath = await createFakeBdStore({ projectRoot, path: "/tmp/wrong-beads" });
  assert.throws(
    () =>
      verifyBeadsStore({
        adapter,
        beadId: "example-app-123",
        beadsDir: projectBeadsDir,
        env: {
          BEADS_DIR: projectBeadsDir,
          AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
          FAKE_BD_STORE: storePath,
          PATH: process.env.PATH
        }
      }),
    /wrong beads store/
  );
});

test("verifyBeadsStore rejects unresolved dependencies and conflicting claims", async () => {
  const { adapter } = await loadAdapter("example-app");
  const dependencyStore = await createFakeBdStore({
    projectRoot,
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Blocked bead",
        description: "",
        design: "",
        acceptance_criteria: "",
        riskClass: "normal-code",
        dependencies: [{ id: "example-app-999", status: "open" }],
        claimed: false,
        claimConflict: false
      }
    }
  });
  assert.throws(
    () =>
      verifyBeadsStore({
        adapter,
        beadId: "example-app-123",
        beadsDir: projectBeadsDir,
        env: {
          BEADS_DIR: projectBeadsDir,
          AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
          FAKE_BD_STORE: dependencyStore,
          PATH: process.env.PATH
        }
      }),
    /unresolved dependencies/
  );
  const conflictStore = await createFakeBdStore({
    projectRoot,
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Conflicted bead",
        description: "",
        design: "",
        acceptance_criteria: "",
        riskClass: "normal-code",
        dependencies: [],
        claimed: false,
        claimConflict: true
      }
    }
  });
  assert.throws(
    () =>
      verifyBeadsStore({
        adapter,
        beadId: "example-app-123",
        beadsDir: projectBeadsDir,
        env: {
          BEADS_DIR: projectBeadsDir,
          AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
          FAKE_BD_STORE: conflictStore,
          PATH: process.env.PATH
        }
      }),
    /conflicting claim/
  );
});
