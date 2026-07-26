import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { assertCommandsAllowed, assertOwnedPaths, scanPrivacy } from "../src/lib/guardrails.mjs";
import { createTextFile } from "./helpers.mjs";

test("guardrails reject protected git mutation commands", () => {
  assert.throws(() => assertCommandsAllowed(["git add ."]), /forbidden worker command/);
});

test("guardrails reject writes outside owned paths", () => {
  assert.throws(
    () =>
      assertOwnedPaths({
        ownedPaths: ["src"],
        changedPaths: ["docs/file.md"],
        protectedPaths: []
      }),
    /outside ownership boundary/
  );
});

test("privacy scan skips local data stores it does not author", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-privacy-resources-"));
  const generated = ["Generated", " with ", "Codex"].join("");
  const actorEmail = ["actor", "@", "users.noreply.github.com"].join("");
  await createTextFile(path.join(dir, ".resources", "beads", "upstream.md"), generated);
  await createTextFile(path.join(dir, ".beads", "embeddeddolt", "noms", "chunk"), actorEmail);
  assert.deepEqual(await scanPrivacy(dir), []);

  await createTextFile(path.join(dir, "tracked.md"), generated);
  assert.equal((await scanPrivacy(dir)).length, 1);
});

test("privacy scan allows git transport and rejects personal emails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-privacy-"));
  const transport = ["git", "@", "github.com:example-org/agent-relay.git (fetch)"].join("");
  const generated = ["Generated", " with ", "Codex"].join("");
  const personalEmail = ["person", "@", "example.net"].join("");
  await createTextFile(path.join(dir, "remote.txt"), `${"origin "} ${transport}`.replace("  ", " "));
  await createTextFile(path.join(dir, "note.md"), generated);
  assert.equal((await scanPrivacy(dir)).length, 1);

  await createTextFile(path.join(dir, "personal.txt"), ["Contact me at ", personalEmail].join(""));
  const findings = await scanPrivacy(dir);
  assert.equal(findings.some((finding) => finding.issue === `email:${personalEmail}`), true);
});
