import test from "node:test";
import assert from "node:assert/strict";
import { verifyBeadsStore } from "../src/lib/beads.mjs";
import { loadAdapter } from "../src/lib/adapter.mjs";
import { createFakeBdStore } from "./helpers.mjs";
import { repoPath } from "../src/lib/paths.mjs";

test("verifyBeadsStore validates array-backed Beads payloads, acceptance_criteria, comments, and claim", async () => {
  const { adapter } = await loadAdapter("example-app");
  const storePath = await createFakeBdStore({
    comments: {
      "example-app-123": [{ text: "{\"kind\":\"note\",\"body\":\"checkpoint\"}" }]
    }
  });
  const result = verifyBeadsStore({
    adapter,
    beadId: "example-app-123",
    env: {
      BEADS_DIR: "/home/example-user/.example-beads",
      AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
      FAKE_BD_STORE: storePath,
      PATH: process.env.PATH
    }
  });
  assert.equal(result.store, "/home/example-user/.example-beads");
  assert.equal(result.bead.id, "example-app-123");
  assert.equal(result.bead.acceptance_criteria.includes("delivery pauses safely"), true);
  assert.equal(Array.isArray(result.comments), true);
  assert.equal(result.claim.claimed, true);
}, { signal: AbortSignal.timeout(5000) });

test("verifyBeadsStore fails on wrong store", async () => {
  const { adapter } = await loadAdapter("example-app");
  const storePath = await createFakeBdStore({ path: "/tmp/wrong-beads" });
  assert.throws(
    () =>
      verifyBeadsStore({
        adapter,
        beadId: "example-app-123",
        env: {
          BEADS_DIR: "/home/example-user/.example-beads",
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
        env: {
          BEADS_DIR: "/home/example-user/.example-beads",
          AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
          FAKE_BD_STORE: dependencyStore,
          PATH: process.env.PATH
        }
      }),
    /unresolved dependencies/
  );
  const conflictStore = await createFakeBdStore({
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
        env: {
          BEADS_DIR: "/home/example-user/.example-beads",
          AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
          FAKE_BD_STORE: conflictStore,
          PATH: process.env.PATH
        }
      }),
    /conflicting claim/
  );
});
