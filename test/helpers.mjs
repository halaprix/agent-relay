import os from "node:os";
import path from "node:path";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { repoPath } from "../src/lib/paths.mjs";
import { writeJson } from "../src/lib/fs.mjs";

// Every fixture directory used by the test suite lives under a single
// session-scoped parent instead of being scattered directly at the tmpdir
// root. `node --test test/*.test.mjs` runs each test file as its own
// process, so a lazily-created per-process parent (cleaned up via that
// file's `test.after` hook) is sufficient to keep tmpdir clean without
// needing any cross-process coordination.
let sessionRootPromise = null;

function sessionRoot() {
  sessionRootPromise ??= mkdtemp(path.join(os.tmpdir(), "agent-relay-session-"));
  return sessionRootPromise;
}

// Allocate a uniquely-named fixture directory inside this process's session
// parent. `prefix` behaves exactly like the prefix argument to `mkdtemp`.
export async function fixtureDir(prefix) {
  const root = await sessionRoot();
  return mkdtemp(path.join(root, prefix));
}

// Recursively remove this process's session parent, if one was created.
// Call from a `test.after` hook in every test file that (directly or
// transitively, via a helper above) allocates a fixture.
export async function cleanupFixtures() {
  if (!sessionRootPromise) return;
  const root = await sessionRootPromise;
  sessionRootPromise = null;
  await rm(root, { recursive: true, force: true });
}

export const defaultAdapterBeadsRoot = JSON.parse(
  await readFile(repoPath("adapters", "example-app.json"), "utf8")
).beads.requiredDir;

export function beadsDirFor(projectRoot) {
  return path.resolve(projectRoot, defaultAdapterBeadsRoot);
}

export async function createRepoFixture({ exclude = [] } = {}) {
  const fixtureRoot = path.join(await fixtureDir("agent-relay-repo-"), "repo");
  const excluded = new Set([".git", "node_modules", ...exclude]);
  await cp(repoPath(), fixtureRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(repoPath(), source);
      return ![...excluded].some(
        (prefix) => relative === prefix || relative.startsWith(`${prefix}${path.sep}`)
      );
    }
  });
  return fixtureRoot;
}

export async function createProjectFixture() {
  const projectRoot = await fixtureDir("agent-relay-project-");
  await cp(repoPath("test", "fixtures", "project-template"), projectRoot, { recursive: true });
  await mkdir(path.join(projectRoot, ".git", "info"), { recursive: true });
  await writeFile(path.join(projectRoot, ".git", "info", "exclude"), "", "utf8");
  await chmod(path.join(projectRoot, "scripts", "dev", "worktree-setup.sh"), 0o755);
  return projectRoot;
}

export async function seedRelayConfig(projectRoot, config) {
  const root = path.join(projectRoot, ".agents", "agent-relay");
  await mkdir(root, { recursive: true });
  await writeJson(path.join(root, "config.json"), config);
}

export async function writeState(projectRoot, beadId, state) {
  const root = path.join(projectRoot, ".agents", "agent-relay", "state");
  await mkdir(root, { recursive: true });
  await writeJson(path.join(root, `${beadId}.json`), state);
}

export async function createFakeBdStore({ projectRoot = null, ...overrides } = {}) {
  const dir = await fixtureDir("agent-relay-bd-");
  const storePath = path.join(dir, "store.json");
  const defaultIssue = {
    id: "example-app-123",
    title: "Test bead",
    description: "Implement the requested change set.",
    design: "Follow the current architecture and preserve safety boundaries.",
    acceptance_criteria: "Tests pass and delivery pauses safely when config is missing.",
    riskClass: "normal-code",
    dependencies: [],
    claimed: false,
    claimConflict: false
  };
  const store = {
    path: projectRoot ? beadsDirFor(projectRoot) : path.resolve(dir, defaultAdapterBeadsRoot),
    whereDetails: [
      "database: embedded-dolt",
      "status: healthy"
    ],
    primeOutput: "## Persistent Memories (1)\n- agent-instruction-files-structure",
    memories: [
      {
        id: "memory-1",
        body: "agent-instruction-files-structure"
      }
    ],
    issues: {
      "example-app-123": defaultIssue
    },
    comments: {
      "example-app-123": []
    },
    children: {},
    ...overrides
  };
  for (const [issueId, issue] of Object.entries(store.issues)) {
    if (issue.acceptance && !issue.acceptance_criteria) {
      issue.acceptance_criteria = issue.acceptance;
      delete issue.acceptance;
    }
    if (issue.comments) {
      store.comments[issueId] = issue.comments;
      delete issue.comments;
    }
    store.comments[issueId] ||= [];
  }
  await writeJson(storePath, store);
  return storePath;
}

export async function createGitStatuses(statuses) {
  const dir = await fixtureDir("agent-relay-git-");
  const filePath = path.join(dir, "statuses.json");
  await writeJson(filePath, { statuses });
  return filePath;
}

export async function createFakeGitStore(projectRoot, overrides = {}) {
  const dir = await fixtureDir("agent-relay-fake-git-");
  const filePath = path.join(dir, "git-store.json");
  await writeJson(filePath, {
    projectRoot,
    baseSha: "base-sha-123",
    mainHead: "base-sha-123",
    mainBranch: "dev",
    remotes: "origin git@github.com:example-org/agent-relay.git (fetch)\norigin git@github.com:example-org/agent-relay.git (push)",
    mainStatusQueue: [],
    worktrees: {},
    records: {
      commands: [],
      staged: [],
      commits: [],
      pushes: [],
      removals: [],
      prunes: []
    },
    ...overrides
  });
  return filePath;
}

export async function createFakeProviderStore(steps) {
  const dir = await fixtureDir("agent-relay-provider-");
  const filePath = path.join(dir, "provider-store.json");
  await writeJson(filePath, {
    calls: [],
    steps
  });
  return filePath;
}

export async function createFakeGhStore(overrides = {}) {
  const dir = await fixtureDir("agent-relay-gh-");
  const filePath = path.join(dir, "gh-store.json");
  await writeJson(filePath, {
    prs: [],
    fail: false,
    ...overrides
  });
  return filePath;
}

export async function createFakeGateStore(steps) {
  const dir = await fixtureDir("agent-relay-gate-");
  const filePath = path.join(dir, "gate-store.json");
  await writeJson(filePath, { steps });
  return filePath;
}

export async function createTextFile(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function createCommandShim(dir, name, body) {
  const filePath = path.join(dir, name);
  await createTextFile(filePath, body);
  await chmod(filePath, 0o755);
  return filePath;
}
