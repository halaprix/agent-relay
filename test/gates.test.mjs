import test from "node:test";
import assert from "node:assert/strict";
import { runGateGroup } from "../src/lib/gates.mjs";
import { createProjectFixture } from "./helpers.mjs";
import { repoPath } from "../src/lib/paths.mjs";

test("runGateGroup records pass and human-only gates", async () => {
  const projectRoot = await createProjectFixture();
  const results = await runGateGroup({
    adapter: {
      gates: {
        groups: {
          sample: [
            {
              name: "pass",
              command: [process.execPath, repoPath("test", "fixtures", "fake-gate.mjs")]
            },
            {
              name: "manual",
              humanOnly: true,
              reason: "manual gate"
            }
          ]
        }
      }
    },
    projectRoot
  });
  assert.equal(results[0].status, "passed");
  assert.equal(results[1].status, "human-action-required");
});
