import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  buildScopeLockedDiffArtifact,
  buildStagedDiffArtifact,
  captureSnapshot,
  stageExplicitPaths
} from "../src/lib/git.mjs";
import { cleanupFixtures, createCommandShim, createProjectFixture, fixtureDir } from "./helpers.mjs";

const execFile = promisify(execFileCallback);

test.after(cleanupFixtures);

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

  const worktreeArtifactPath = path.join(await fixtureDir("agent-relay-git-artifact-"), "worktree.json");
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
  const stagedArtifactPath = path.join(await fixtureDir("agent-relay-git-stage-"), "staged.json");
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
  const driftedArtifactPath = path.join(await fixtureDir("agent-relay-git-drift-"), "worktree.json");
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

test("scope-locked diffs ignore the reference cache and relay state", { timeout: 15000 }, async () => {
  const projectRoot = await createRealGitProjectFixture();
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await writeFile(path.join(projectRoot, "src", "base.txt"), "base\n", "utf8");
  await runGitCommand(projectRoot, ["add", "."]);
  await runGitCommand(projectRoot, ["commit", "-m", "fixture"]);

  const beforeSnapshot = await captureSnapshot(projectRoot, { ignorePrefixes: [".git"] });
  await mkdir(path.join(projectRoot, ".resources", "beads"), { recursive: true });
  await writeFile(path.join(projectRoot, ".resources", "beads", "upstream.md"), "cached docs\n", "utf8");
  await writeFile(path.join(projectRoot, "src", "base.txt"), "changed\n", "utf8");

  const artifactPath = path.join(await fixtureDir("agent-relay-git-resources-"), "worktree.json");
  const { changedPaths } = await buildScopeLockedDiffArtifact({
    worktreePath: projectRoot,
    beforeSnapshot,
    filePath: artifactPath
  });
  assert.deepEqual(changedPaths, ["src/base.txt"]);
});

test("broken symlinks remain symlinks in reviewed and staged artifacts", { timeout: 15000 }, async () => {
  const projectRoot = await createRealGitProjectFixture();
  const gitConfig = {
    git: {
      command: "git",
      env: {},
      statusArgs: ["status", "--short"]
    }
  };

  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await writeFile(path.join(projectRoot, "src", "base.txt"), "base\n", "utf8");
  await runGitCommand(projectRoot, ["add", "."]);
  await runGitCommand(projectRoot, ["commit", "-m", "fixture"]);

  const beforeSnapshot = await captureSnapshot(projectRoot, { ignorePrefixes: [".git"] });
  await symlink("missing-target.txt", path.join(projectRoot, "src", "broken-link"));

  const worktreeArtifactPath = path.join(await fixtureDir("agent-relay-broken-link-"), "worktree.json");
  const { changedPaths } = await buildScopeLockedDiffArtifact({
    worktreePath: projectRoot,
    beforeSnapshot,
    filePath: worktreeArtifactPath
  });
  assert.deepEqual(changedPaths, ["src/broken-link"]);

  await stageExplicitPaths(gitConfig, projectRoot, changedPaths);
  const stagedArtifactPath = path.join(await fixtureDir("agent-relay-broken-stage-"), "staged.json");
  await buildStagedDiffArtifact({
    config: gitConfig,
    worktreePath: projectRoot,
    changedPaths,
    filePath: stagedArtifactPath
  });

  const reviewedArtifact = await readFile(worktreeArtifactPath, "utf8");
  const stagedArtifact = await readFile(stagedArtifactPath, "utf8");
  assert.equal(stagedArtifact, reviewedArtifact);
  const record = JSON.parse(reviewedArtifact).records[0];
  assert.equal(record.type, "symlink");
  assert.equal(record.mode, "120000");
  assert.equal(record.symlinkTarget, "missing-target.txt");
});

test("runGitBuffer (via buildStagedDiffArtifact) does not leak its capture temp dir on success or failure", { timeout: 15000 }, async () => {
  const projectRoot = await createRealGitProjectFixture();
  const gitConfig = {
    git: {
      command: "git",
      env: {},
      statusArgs: ["status", "--short"]
    }
  };
  await writeFile(path.join(projectRoot, "tracked.txt"), "tracked\n", "utf8");
  await runGitCommand(projectRoot, ["add", "."]);
  await runGitCommand(projectRoot, ["commit", "-m", "fixture"]);
  await writeFile(path.join(projectRoot, "tracked.txt"), "changed\n", "utf8");
  await stageExplicitPaths(gitConfig, projectRoot, ["tracked.txt"]);

  // Wrap real git in a shim that records the capture dir it was handed, so cleanup is
  // asserted on those exact paths. Counting `agent-relay-git-capture-*` in tmpdir would
  // be racy: the prefix has no per-call discriminator and `node --test` runs test files
  // concurrently, so a sibling file's in-flight git call lands in the count.
  const shimDir = await fixtureDir("agent-relay-git-capture-cleanup-");
  const stagedArtifactPath = path.join(shimDir, "staged.json");
  const reportPath = path.join(shimDir, "capture-report.txt");
  const shimPath = await createCommandShim(
    shimDir,
    "git-reporting-shim",
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$(dirname "$AGENT_RELAY_STDOUT_FILE")" >> "$AGENT_RELAY_TEST_CAPTURE_REPORT"',
      'exec git "$@"',
      ""
    ].join("\n")
  );
  const reportingGitConfig = {
    git: {
      ...gitConfig.git,
      command: shimPath,
      env: { AGENT_RELAY_TEST_CAPTURE_REPORT: reportPath }
    }
  };
  const reportedDirs = async () =>
    (await readFile(reportPath, "utf8")).split("\n").filter(Boolean);

  await buildStagedDiffArtifact({
    config: reportingGitConfig,
    worktreePath: projectRoot,
    changedPaths: ["tracked.txt"],
    filePath: stagedArtifactPath
  });
  const afterSuccess = await reportedDirs();
  assert.ok(afterSuccess.length >= 1, "the git shim reported no capture dir");
  for (const dir of afterSuccess) {
    assert.equal(existsSync(dir), false, `leaked ${dir}`);
  }

  // Same shim, but exiting non-zero: the capture dir is still reported before the
  // failure, so cleanup on the error path is checked against a known path too.
  const failingShimPath = await createCommandShim(
    shimDir,
    "git-failing-shim",
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$(dirname "$AGENT_RELAY_STDOUT_FILE")" >> "$AGENT_RELAY_TEST_CAPTURE_REPORT"',
      "exit 3",
      ""
    ].join("\n")
  );
  await assert.rejects(() =>
    buildStagedDiffArtifact({
      config: { git: { ...reportingGitConfig.git, command: failingShimPath } },
      worktreePath: projectRoot,
      changedPaths: ["tracked.txt"],
      filePath: stagedArtifactPath
    })
  );
  const afterFailure = await reportedDirs();
  assert.ok(
    afterFailure.length > afterSuccess.length,
    "the failing git call did not report a capture dir"
  );
  for (const dir of afterFailure) {
    assert.equal(existsSync(dir), false, `leaked ${dir}`);
  }
});
