import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  buildScopeLockedDiffArtifact,
  buildStagedDiffArtifact,
  captureSnapshot,
  stageExplicitPaths
} from "../src/lib/git.mjs";
import { createProjectFixture } from "./helpers.mjs";

const execFile = promisify(execFileCallback);

async function runGitCommand(cwd, args) {
  await execFile("git", args, { cwd });
}

async function createRealGitProjectFixture() {
  const projectRoot = await createProjectFixture();
  await rm(path.join(projectRoot, ".git"), { recursive: true, force: true });
  await runGitCommand(projectRoot, ["init", "-b", "dev"]);
  await runGitCommand(projectRoot, ["config", "user.name", "Relay Tester"]);
  await runGitCommand(projectRoot, ["config", "user.email", "relay-tester@example.com"]);
  return projectRoot;
}

test("canonical diff artifacts preserve exact bytes, deletions, executable mode, and symlink targets", { timeout: 15000 }, async () => {
  const projectRoot = await createRealGitProjectFixture();
  const gitConfig = {
    git: {
      command: "git",
      env: {},
      statusArgs: ["status", "--short"]
    }
  };

  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await writeFile(path.join(projectRoot, "src", "binary.bin"), Buffer.from([0x7f]));
  await writeFile(path.join(projectRoot, "src", "delete-me.txt"), "delete me\n", "utf8");
  await writeFile(path.join(projectRoot, "src", "mode.sh"), "#!/usr/bin/env bash\necho mode\n", "utf8");
  await chmod(path.join(projectRoot, "src", "mode.sh"), 0o644);
  await runGitCommand(projectRoot, ["add", "."]);
  await runGitCommand(projectRoot, ["commit", "-m", "fixture"]);

  const beforeSnapshot = await captureSnapshot(projectRoot, { ignorePrefixes: [".git"] });

  await writeFile(path.join(projectRoot, "src", "binary.bin"), Buffer.from([0x80]));
  await unlink(path.join(projectRoot, "src", "delete-me.txt"));
  await chmod(path.join(projectRoot, "src", "mode.sh"), 0o755);
  await symlink("binary.bin", path.join(projectRoot, "src", "binary-link"));

  const worktreeArtifactPath = path.join(await mkdtemp(path.join(os.tmpdir(), "agent-relay-git-artifact-")), "worktree.json");
  const { changedPaths } = await buildScopeLockedDiffArtifact({
    worktreePath: projectRoot,
    beforeSnapshot,
    filePath: worktreeArtifactPath
  });
  assert.deepEqual(changedPaths, [
    "src/binary-link",
    "src/binary.bin",
    "src/delete-me.txt",
    "src/mode.sh"
  ]);

  await stageExplicitPaths(gitConfig, projectRoot, changedPaths);
  const stagedArtifactPath = path.join(await mkdtemp(path.join(os.tmpdir(), "agent-relay-git-stage-")), "staged.json");
  await buildStagedDiffArtifact({
    config: gitConfig,
    worktreePath: projectRoot,
    changedPaths,
    filePath: stagedArtifactPath
  });

  const reviewedArtifact = await readFile(worktreeArtifactPath, "utf8");
  const stagedArtifact = await readFile(stagedArtifactPath, "utf8");
  assert.equal(stagedArtifact, reviewedArtifact);

  const artifact = JSON.parse(reviewedArtifact);
  const records = new Map(artifact.records.map((record) => [record.path, record]));
  assert.equal(records.get("src/binary.bin").bytesBase64, Buffer.from([0x80]).toString("base64"));
  assert.equal(records.get("src/mode.sh").mode, "100755");
  assert.equal(records.get("src/delete-me.txt").status, "deleted");
  assert.equal(records.get("src/binary-link").type, "symlink");
  assert.equal(records.get("src/binary-link").mode, "120000");
  assert.equal(records.get("src/binary-link").symlinkTarget, "binary.bin");

  await writeFile(path.join(projectRoot, "src", "binary.bin"), Buffer.from([0x81]));
  const driftedArtifactPath = path.join(await mkdtemp(path.join(os.tmpdir(), "agent-relay-git-drift-")), "worktree.json");
  await buildScopeLockedDiffArtifact({
    worktreePath: projectRoot,
    beforeSnapshot,
    filePath: driftedArtifactPath
  });
  const driftedArtifact = await readFile(driftedArtifactPath, "utf8");
  assert.notEqual(driftedArtifact, stagedArtifact);
  const drifted = JSON.parse(driftedArtifact);
  const driftedBinary = drifted.records.find((record) => record.path === "src/binary.bin");
  assert.equal(driftedBinary.bytesBase64, Buffer.from([0x81]).toString("base64"));
});
