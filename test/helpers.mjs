import os from "node:os";
import path from "node:path";
import { chmod, cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { repoPath } from "../src/lib/paths.mjs";
import { writeJson } from "../src/lib/fs.mjs";

export async function createProjectFixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "agent-relay-project-"));
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

export async function createFakeBdStore(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-bd-"));
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
    path: "/home/example-user/.example-beads",
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-git-"));
  const filePath = path.join(dir, "statuses.json");
  await writeJson(filePath, { statuses });
  return filePath;
}

export async function createFakeGitStore(projectRoot, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-fake-git-"));
  const filePath = path.join(dir, "git-store.json");
  await writeJson(filePath, {
    projectRoot,
    baseSha: "base-sha-123",
    mainHead: "base-sha-123",
    mainBranch: "dev",
    remotes: "origin git@github.com:example-user/agent-relay.git (fetch)\norigin git@github.com:example-user/agent-relay.git (push)",
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-provider-"));
  const filePath = path.join(dir, "provider-store.json");
  await writeJson(filePath, {
    calls: [],
    steps
  });
  return filePath;
}

export async function createFakeGhStore(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-gh-"));
  const filePath = path.join(dir, "gh-store.json");
  await writeJson(filePath, {
    prs: [],
    fail: false,
    ...overrides
  });
  return filePath;
}

export async function createFakeGateStore(steps) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-gate-"));
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
