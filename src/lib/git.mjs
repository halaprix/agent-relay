import path from "node:path";
import { cp, readFile, writeFile } from "node:fs/promises";
import { runProviderCommand } from "./provider.mjs";
import { ensureDir, listFilesRecursive, pathExists, toPosixRelative } from "./fs.mjs";
import { sha256Text } from "./hash.mjs";

function gitCommand(config) {
  return config.git?.command || "git";
}

function gitEnv(config) {
  return config.git?.env || {};
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

export async function getGitStatus(config, cwd) {
  const run = await runGit(config, cwd, config.git?.statusArgs || ["status", "--short"]);
  if (run.code !== 0) {
    throw new Error(`git status failed in ${cwd}: ${run.stderr || run.stdout}`);
  }
  return run.stdout.trim();
}

export async function getGitRemotes(config, cwd) {
  const run = await runGit(config, cwd, ["remote", "-v"]);
  if (run.code !== 0) {
    throw new Error(`git remote -v failed in ${cwd}: ${run.stderr || run.stdout}`);
  }
  return run.stdout.trim();
}

export async function getGitHead(config, cwd) {
  const run = await runGit(config, cwd, ["rev-parse", "HEAD"]);
  if (run.code !== 0) {
    throw new Error(`git rev-parse HEAD failed in ${cwd}: ${run.stderr || run.stdout}`);
  }
  return run.stdout.trim();
}

export async function getGitBranch(config, cwd) {
  const run = await runGit(config, cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (run.code !== 0) {
    throw new Error(`git symbolic-ref failed in ${cwd}: ${run.stderr || run.stdout}`);
  }
  return run.stdout.trim();
}

export async function resolveBaseSha(config, projectRoot, baseBranch) {
  const run = await runGit(config, projectRoot, ["rev-parse", `origin/${baseBranch}`]);
  if (run.code !== 0) {
    throw new Error(`git rev-parse failed for ${baseBranch}: ${run.stderr || run.stdout}`);
  }
  return run.stdout.trim();
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
    const content = await readFile(filePath, "utf8").catch(() => "");
    snapshot[relativePath] = sha256Text(content);
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
  const afterSnapshot = await captureSnapshot(worktreePath, { ignorePrefixes: [".git", ".agents/agent-relay"] });
  const changedPaths = diffSnapshots(beforeSnapshot, afterSnapshot);
  const sections = [];
  for (const relativePath of changedPaths) {
    const absolutePath = path.join(worktreePath, relativePath);
    const content = await readFile(absolutePath, "utf8").catch(() => "<deleted or unreadable>");
    sections.push(`### ${relativePath}\n${content}`);
  }
  await writeFile(
    filePath,
    `# Scope-Locked Diff\n\n${sections.join("\n\n")}\n`,
    "utf8"
  );
  return { changedPaths, afterSnapshot };
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
