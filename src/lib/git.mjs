import path from "node:path";
import { spawn } from "node:child_process";
import { cp, lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { SNAPSHOT_IGNORE_PREFIXES } from "./constants.mjs";
import { ensureDir, listFilesRecursive, pathExists, toPosixRelative, withTempDir } from "./fs.mjs";
import { sha256Bytes, sha256Text } from "./hash.mjs";
import { runProviderCommand } from "./provider.mjs";

function gitCommand(config) {
  return config.git?.command || "git";
}

function gitEnv(config) {
  return config.git?.env || {};
}

function resolveSpawn(command, args) {
  if (command.endsWith(".mjs") || command.endsWith(".js")) {
    return {
      command: process.execPath,
      args: [command, ...args]
    };
  }
  return { command, args };
}

function gitModeFromFsStats(stats) {
  if (stats.isSymbolicLink()) {
    return "120000";
  }
  if (stats.isFile()) {
    return (stats.mode & 0o111) !== 0 ? "100755" : "100644";
  }
  throw new Error("scope-locked artifacts only support files and symlinks");
}

function buildDeletedRecord(relativePath) {
  return {
    path: relativePath,
    status: "deleted",
    type: "deleted",
    mode: null,
    sizeBytes: 0,
    bytesSha256: null,
    bytesBase64: null,
    symlinkTarget: null
  };
}

function buildPresentRecord({ relativePath, type, mode, bytes, symlinkTarget = null }) {
  return {
    path: relativePath,
    status: "present",
    type,
    mode,
    sizeBytes: bytes.length,
    bytesSha256: sha256Bytes(bytes),
    bytesBase64: bytes.toString("base64"),
    symlinkTarget
  };
}

function recordFingerprint(record) {
  return sha256Text(JSON.stringify(record));
}

function sortRecords(records) {
  return [...records].sort((left, right) => left.path.localeCompare(right.path));
}

async function recordWorktreePath(rootDir, relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return buildDeletedRecord(relativePath);
    }
    throw error;
  }
  const mode = gitModeFromFsStats(stats);
  if (stats.isSymbolicLink()) {
    const symlinkTarget = await readlink(absolutePath);
    const bytes = Buffer.from(symlinkTarget, "utf8");
    return buildPresentRecord({
      relativePath,
      type: "symlink",
      mode,
      bytes,
      symlinkTarget
    });
  }
  if (!stats.isFile()) {
    throw new Error(`unsupported worktree entry type for ${relativePath}`);
  }
  const bytes = await readFile(absolutePath);
  return buildPresentRecord({
    relativePath,
    type: "file",
    mode,
    bytes
  });
}

async function runGitBuffer(config, cwd, args, { timeoutMs = 30000 } = {}) {
  return withTempDir("agent-relay-git-capture-", (captureDir) =>
    runGitBufferInCaptureDir(config, cwd, args, timeoutMs, captureDir)
  );
}

function runGitBufferInCaptureDir(config, cwd, args, timeoutMs, captureDir) {
  const spawnSpec = resolveSpawn(gitCommand(config), args);
  const stdoutPath = path.join(captureDir, "stdout.bin");
  const stderrPath = path.join(captureDir, "stderr.log");
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env: {
        ...process.env,
        ...gitEnv(config),
        AGENT_RELAY_STDOUT_FILE: stdoutPath,
        AGENT_RELAY_STDERR_FILE: stderrPath
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const resolveRun = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(payload);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on("error", (error) => {
      resolveRun({
        code: 1,
        stdout: Buffer.concat(stdoutChunks),
        stderr: `${Buffer.concat(stderrChunks).toString("utf8")}${stderrChunks.length > 0 ? "\n" : ""}${error.message}`
      });
    });
    child.on("close", (code) => {
      Promise.all([
        stdoutChunks.length > 0 ? Promise.resolve(Buffer.concat(stdoutChunks)) : readFile(stdoutPath).catch(() => Buffer.alloc(0)),
        stderrChunks.length > 0 ? Promise.resolve(Buffer.concat(stderrChunks).toString("utf8")) : readFile(stderrPath, "utf8").catch(() => "")
      ]).then(([capturedStdout, capturedStderr]) =>
        resolveRun({
          code: code ?? 1,
          stdout: capturedStdout,
          stderr: capturedStderr
        })
      );
    });
  });
}

async function getIndexEntries(config, worktreePath, changedPaths) {
  const run = await runGitBuffer(config, worktreePath, ["ls-files", "--stage", "-z", "--", ...changedPaths]);
  if (run.code !== 0) {
    throw new Error(`git ls-files failed: ${run.stderr}`);
  }
  const entries = new Map();
  for (const rawEntry of run.stdout.toString("utf8").split("\0")) {
    if (!rawEntry) {
      continue;
    }
    const tabIndex = rawEntry.indexOf("\t");
    if (tabIndex === -1) {
      throw new Error(`unexpected ls-files entry: ${rawEntry}`);
    }
    const metadata = rawEntry.slice(0, tabIndex).split(" ");
    if (metadata.length !== 3) {
      throw new Error(`unexpected ls-files metadata: ${rawEntry}`);
    }
    const [mode, objectId, stage] = metadata;
    if (stage !== "0") {
      throw new Error(`unsupported staged conflict entry for ${rawEntry.slice(tabIndex + 1)}`);
    }
    entries.set(rawEntry.slice(tabIndex + 1), { mode, objectId });
  }
  return entries;
}

async function getGitBlob(config, worktreePath, objectId) {
  const run = await runGitBuffer(config, worktreePath, ["cat-file", "-p", objectId]);
  if (run.code !== 0) {
    throw new Error(`git cat-file failed for ${objectId}: ${run.stderr}`);
  }
  return run.stdout;
}

async function recordIndexPath(config, worktreePath, relativePath, indexEntry) {
  if (!indexEntry) {
    return buildDeletedRecord(relativePath);
  }
  const bytes = await getGitBlob(config, worktreePath, indexEntry.objectId);
  if (indexEntry.mode === "120000") {
    const symlinkTarget = bytes.toString("utf8");
    return buildPresentRecord({
      relativePath,
      type: "symlink",
      mode: indexEntry.mode,
      bytes,
      symlinkTarget
    });
  }
  return buildPresentRecord({
    relativePath,
    type: "file",
    mode: indexEntry.mode,
    bytes
  });
}

async function writeCanonicalArtifact(filePath, records) {
  const artifact = {
    format: "agent-relay-diff/v1",
    records: sortRecords(records)
  };
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function runGit(config, cwd, args, { timeoutMs = 30000 } = {}) {
  return runProviderCommand({
    providerName: `git:${args.join(" ")}`,
    command: gitCommand(config),
    args,
    cwd,
    env: gitEnv(config),
    timeoutMs
  });
}

async function runGitTextOrThrow(config, cwd, args, buildErrorMessage) {
  const run = await runGit(config, cwd, args);
  if (run.code !== 0) {
    throw new Error(buildErrorMessage(run));
  }
  return run.stdout.trim();
}

export async function getGitStatus(config, cwd) {
  return runGitTextOrThrow(config, cwd, config.git?.statusArgs || ["status", "--short"], (run) =>
    `git status failed in ${cwd}: ${run.stderr || run.stdout}`
  );
}

export async function getGitRemotes(config, cwd) {
  return runGitTextOrThrow(config, cwd, ["remote", "-v"], (run) =>
    `git remote -v failed in ${cwd}: ${run.stderr || run.stdout}`
  );
}

export async function getGitHead(config, cwd) {
  return runGitTextOrThrow(config, cwd, ["rev-parse", "HEAD"], (run) =>
    `git rev-parse HEAD failed in ${cwd}: ${run.stderr || run.stdout}`
  );
}

export async function getGitBranch(config, cwd) {
  return runGitTextOrThrow(config, cwd, ["symbolic-ref", "--short", "HEAD"], (run) =>
    `git symbolic-ref failed in ${cwd}: ${run.stderr || run.stdout}`
  );
}

export async function resolveBaseSha(config, projectRoot, baseBranch) {
  return runGitTextOrThrow(config, projectRoot, ["rev-parse", `origin/${baseBranch}`], (run) =>
    `git rev-parse failed for ${baseBranch}: ${run.stderr || run.stdout}`
  );
}

export async function runGitText(config, cwd, args) {
  const run = await runProviderCommand({
    providerName: `git:${args.join(" ")}`,
    command: config.git.command,
    args,
    cwd,
    env: config.git.env || {},
    timeoutMs: 30000
  });
  if (run.code !== 0) {
    return "";
  }
  return (run.stdout || "").trim();
}

export async function createDetachedWorktree(config, projectRoot, worktreePath, baseSha, branch) {
  await ensureDir(path.dirname(worktreePath));
  const addRun = await runGit(config, projectRoot, ["worktree", "add", "--detach", worktreePath, baseSha], {
    timeoutMs: 120000
  });
  if (addRun.code !== 0) {
    throw new Error(`git worktree add failed: ${addRun.stderr || addRun.stdout}`);
  }
  const branchRun = await runGit(config, worktreePath, ["checkout", "-b", branch, baseSha], {
    timeoutMs: 30000
  });
  if (branchRun.code !== 0) {
    throw new Error(`git checkout -b failed: ${branchRun.stderr || branchRun.stdout}`);
  }
  return { addRun, branchRun };
}

export async function copyProjectForFixture(sourceRoot, worktreePath) {
  if (!(await pathExists(worktreePath))) {
    await cp(sourceRoot, worktreePath, { recursive: true });
  }
}

export async function captureSnapshot(rootDir, { ignorePrefixes = [] } = {}) {
  const snapshot = {};
  const files = await listFilesRecursive(rootDir);
  for (const filePath of files) {
    const relativePath = toPosixRelative(rootDir, filePath);
    if (ignorePrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) {
      continue;
    }
    snapshot[relativePath] = recordFingerprint(await recordWorktreePath(rootDir, relativePath));
  }
  return snapshot;
}

export function diffSnapshots(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

export async function writeSnapshotArtifact(filePath, snapshot) {
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function buildScopeLockedDiffArtifact({ worktreePath, beforeSnapshot, filePath }) {
  const afterSnapshot = await captureSnapshot(worktreePath, { ignorePrefixes: SNAPSHOT_IGNORE_PREFIXES });
  const changedPaths = diffSnapshots(beforeSnapshot, afterSnapshot);
  const records = [];
  for (const relativePath of changedPaths) {
    records.push(await recordWorktreePath(worktreePath, relativePath));
  }
  await writeCanonicalArtifact(filePath, records);
  return { changedPaths, afterSnapshot };
}

export async function buildStagedDiffArtifact({ config, worktreePath, changedPaths, filePath }) {
  const indexEntries = await getIndexEntries(config, worktreePath, changedPaths);
  const records = [];
  for (const relativePath of [...changedPaths].sort()) {
    records.push(await recordIndexPath(config, worktreePath, relativePath, indexEntries.get(relativePath)));
  }
  await writeCanonicalArtifact(filePath, records);
  return filePath;
}

export async function stageExplicitPaths(config, worktreePath, changedPaths) {
  const run = await runGit(config, worktreePath, ["add", "--", ...changedPaths], { timeoutMs: 30000 });
  if (run.code !== 0) {
    throw new Error(`git add failed: ${run.stderr || run.stdout}`);
  }
  return run;
}

export async function commitPaths(config, worktreePath, message) {
  const run = await runGit(config, worktreePath, ["commit", "-m", message], { timeoutMs: 30000 });
  if (run.code !== 0) {
    throw new Error(`git commit failed: ${run.stderr || run.stdout}`);
  }
  return run;
}

export async function pushBranch(config, worktreePath, branch) {
  const run = await runGit(config, worktreePath, ["push", "--set-upstream", "origin", branch], {
    timeoutMs: 120000
  });
  if (run.code !== 0) {
    throw new Error(`git push failed: ${run.stderr || run.stdout}`);
  }
  return run;
}

export async function removeWorktree(config, projectRoot, worktreePath) {
  const removeRun = await runGit(config, projectRoot, ["worktree", "remove", worktreePath], {
    timeoutMs: 120000
  });
  if (removeRun.code !== 0) {
    throw new Error(`git worktree remove failed: ${removeRun.stderr || removeRun.stdout}`);
  }
  const pruneRun = await runGit(config, projectRoot, ["worktree", "prune"], {
    timeoutMs: 120000
  });
  if (pruneRun.code !== 0) {
    throw new Error(`git worktree prune failed: ${pruneRun.stderr || pruneRun.stdout}`);
  }
  return { removeRun, pruneRun };
}
