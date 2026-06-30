import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { repoPath, runStatePath } from "../src/lib/paths.mjs";
import { pathExists, removePath } from "../src/lib/fs.mjs";
import { cleanup, doctor, gates, plan, resume, review, run, setup } from "../src/lib/supervisor.mjs";
import {
  createCommandShim,
  createFakeBdStore,
  createFakeGateStore,
  createFakeGhStore,
  createFakeGitStore,
  createFakeProviderStore,
  createProjectFixture,
  seedRelayConfig,
  writeState
} from "./helpers.mjs";

function relayEnv({ bdStorePath, gateStorePath, gitStorePath, ghStorePath, extra = {} }) {
  return {
    BEADS_DIR: "/home/example-user/.example-beads",
    AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
    FAKE_BD_STORE: bdStorePath,
    FAKE_GATE_STORE: gateStorePath,
    FAKE_GIT_STORE: gitStorePath,
    FAKE_GH_STORE: ghStorePath,
    PATH: process.env.PATH,
    ...extra
  };
}

async function createGateShimPath() {
  const shimDir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-shims-"));
  await createCommandShim(
    shimDir,
    "pnpm",
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${repoPath("test", "fixtures", "fake-gate.mjs")}"\n`
  );
  await createCommandShim(
    shimDir,
    "forge",
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${repoPath("test", "fixtures", "fake-gate.mjs")}"\n`
  );
  return shimDir;
}

function baseConfig(projectRoot, gitStorePath, overrides = {}) {
  return {
    adapter: "example-app",
    mainCheckoutRoot: projectRoot,
    correctionLimit: 2,
    planApprovalRiskClasses: ["money-path", "solidity-core", "shared-infrastructure"],
    providers: {
      claude: null,
      codex: null,
      agy: null
    },
    reviewProviders: ["codex", "agy"],
    pluginMaintenanceMode: false,
    git: {
      command: repoPath("test", "fixtures", "fake-git-driver.mjs"),
      env: {
        FAKE_GIT_STORE: gitStorePath
      },
      statusArgs: ["status", "--short"],
      identity: {
        name: null,
        email: null
      }
    },
    github: {
      command: repoPath("test", "fixtures", "fake-gh.mjs"),
      env: {}
    },
    delivery: null,
    ...overrides
  };
}

function successReviewStep(summary = "clean review", findings = []) {
  return {
    type: "success",
    report: {
      status: findings.length > 0 ? "needs-fix" : "success",
      summary,
      findings,
      commandsAttempted: ["node review.js"]
    }
  };
}

async function mutateBdStore(storePath, mutate) {
  const store = JSON.parse(await readFile(storePath, "utf8"));
  mutate(store);
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return store;
}

test("setup writes local state, syncs roles, and marks .agents/agent-relay ignored locally", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const result = await setup({ projectRoot, adapterName: "example-app" });
  assert.equal(result.ok, true);
  const exclude = await readFile(path.join(projectRoot, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /\.agents\/agent-relay\//);
  assert.equal(result.syncedRoles.length >= 3, true);
  const claudeLaw = await readFile(path.join(projectRoot, "CLAUDE.md"), "utf8");
  assert.equal(claudeLaw.trim(), "# Fixture CLAUDE");
});

test("doctor honors the requested adapter and validates required files", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const result = await doctor({ projectRoot, adapterName: "example-app" });
  assert.equal(result.ok, true);
  assert.equal(result.adapter, "example-app");
});

test("run creates an isolated worktree and executes the coder there", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Test bead",
        description: "Implement the requested change set.",
        design: "Follow the current architecture and preserve safety boundaries.",
        acceptance_criteria: "Tests pass and delivery pauses safely when config is missing.",
        riskClass: "documentation",
        dependencies: [],
        claimed: false,
        claimConflict: false
      }
    }
  });
  const gitStorePath = await createFakeGitStore(projectRoot);
  const gateStorePath = await createFakeGateStore([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  const shimDir = await createGateShimPath();
  const providerStorePath = await createFakeProviderStore([
    {
      type: "success",
      writes: [{ path: "src/feature.ts", content: "export const feature = 1;\n" }],
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: ["src/feature.ts"],
        artifacts: []
      }
    }
  ]);
  const reviewerStorePath = await createFakeProviderStore([successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: {
          FAKE_PROVIDER_STORE: providerStorePath,
          PATH: `${shimDir}:${process.env.PATH}`
        },
        timeoutMs: 1000
      },
      codex: null,
      agy: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: {
          FAKE_PROVIDER_STORE: reviewerStorePath,
          PATH: `${shimDir}:${process.env.PATH}`
        },
        timeoutMs: 1000
      }
    },
    reviewProviders: ["agy"]
  });
  await seedRelayConfig(projectRoot, config);
  const result = await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.state.worktreePath, projectRoot);
  assert.equal(result.state.baseSha, "base-sha-123");
  assert.match(result.state.branch, /^relay\/test-bead-[0-9a-f]{8}$/);
  const providerStore = JSON.parse(await readFile(providerStorePath, "utf8"));
  assert.equal(providerStore.calls.length, 1);
  assert.equal(providerStore.calls[0].cwd, result.state.worktreePath);
  assert.match(providerStore.calls[0].prompt, /Gate groups: types-and-tests/);
  assert.doesNotMatch(providerStore.calls[0].prompt, /formatting|solidity/);
});

test("run retries service failure once, corrects on needs-fix with the same provider, and preserves partial edits across handoff", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Test bead",
        description: "Implement the requested change set.",
        design: "Follow the current architecture and preserve safety boundaries.",
        acceptance_criteria: "Tests pass and delivery pauses safely when config is missing.",
        riskClass: "documentation",
        dependencies: [],
        claimed: false,
        claimConflict: false
      }
    }
  });
  const gitStorePath = await createFakeGitStore(projectRoot);
  const gateStorePath = await createFakeGateStore([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  const shimDir = await createGateShimPath();
  const claudeStore = await createFakeProviderStore([
    {
      type: "service",
      stderr: "service unavailable\n"
    },
    {
      type: "success",
      report: {
        status: "needs-fix",
        summary: "tests still failing",
        ownedPaths: ["."],
        commandsAttempted: ["node retry.js"],
        changedPaths: [],
        artifacts: []
      }
    },
    {
      type: "malformed",
      writes: [{ path: "src/partial.ts", content: "export const partial = true;\n" }]
    }
  ]);
  const codexStore = await createFakeProviderStore([
    {
      type: "success",
      writes: [{ path: "src/final.ts", content: "export const final = true;\n" }],
      report: {
        status: "success",
        summary: "finalized change",
        ownedPaths: ["."],
        commandsAttempted: ["node finalize.js"],
        changedPaths: ["src/final.ts"],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: {
          FAKE_PROVIDER_STORE: claudeStore,
          PATH: `${shimDir}:${process.env.PATH}`
        },
        timeoutMs: 1000
      },
      codex: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: {
          FAKE_PROVIDER_STORE: codexStore,
          PATH: `${shimDir}:${process.env.PATH}`
        },
        timeoutMs: 1000
      },
      agy: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: {
          FAKE_PROVIDER_STORE: reviewerStore,
          PATH: `${shimDir}:${process.env.PATH}`
        },
        timeoutMs: 1000
      }
    },
    reviewProviders: ["agy"]
  });
  await seedRelayConfig(projectRoot, config);
  const result = await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.lastCoder, "codex");
  const claudeCalls = JSON.parse(await readFile(claudeStore, "utf8")).calls.length;
  assert.equal(claudeCalls, 3);
  assert.equal(result.state.latestChangedPaths.includes("src/partial.ts"), true);
});

test("run detects worktree setup failure and main-checkout drift", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Test bead",
        description: "Implement the requested change set.",
        design: "Follow the current architecture and preserve safety boundaries.",
        acceptance_criteria: "Tests pass and delivery pauses safely when config is missing.",
        riskClass: "documentation",
        dependencies: [],
        claimed: false,
        claimConflict: false
      }
    }
  });
  const gitStorePath = await createFakeGitStore(projectRoot, {
    mainStatusQueue: ["", "M drift"]
  });
  const gateStorePath = await createFakeGateStore([]);
  const shimDir = await createGateShimPath();
  const providerStore = await createFakeProviderStore([
    {
      type: "success",
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: [],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: providerStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      codex: null,
      agy: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: reviewerStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      }
    },
    reviewProviders: ["agy"]
  });
  await seedRelayConfig(projectRoot, config);
  await assert.rejects(
    () =>
      run({
        projectRoot,
        adapterName: "example-app",
        beadId: "example-app-123",
        env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { FAKE_SETUP_FAIL: "1", PATH: `${shimDir}:${process.env.PATH}` } })
      }),
    /main checkout drift|worktree setup failed/
  );
});

test("review enforces quorum, resumes from Bead comments without local state, and pauses when delivery is not configured", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore();
  const gitStorePath = await createFakeGitStore(projectRoot);
  const gateStorePath = await createFakeGateStore([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  const shimDir = await createGateShimPath();
  const coderStore = await createFakeProviderStore([
    {
      type: "success",
      writes: [{ path: "src/reviewable.ts", content: "export const reviewable = true;\n" }],
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: ["src/reviewable.ts"],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([
    successReviewStep(),
    successReviewStep()
  ]);
  const secondPlanReviewerStore = await createFakeProviderStore([successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: coderStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      codex: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: reviewerStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      agy: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: secondPlanReviewerStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      }
    },
    reviewProviders: ["codex", "agy"]
  });
  await seedRelayConfig(projectRoot, config);
  const runResult = await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(runResult.ok, true);
  const statePath = runStatePath(projectRoot, "example-app-123");
  assert.equal(await pathExists(statePath), true);
  await seedRelayConfig(projectRoot, {
    ...config,
    reviewProviders: ["codex"]
  });
  const reviewResult = await review({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath })
  });
  assert.equal(reviewResult.exitClass, "provider-quorum-unavailable");
  await removePath(statePath);
  const recoveredConfig = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: config.providers.claude,
      codex: config.providers.codex,
      agy: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: {
          FAKE_PROVIDER_STORE: await createFakeProviderStore([
            successReviewStep()
          ]),
          PATH: `${shimDir}:${process.env.PATH}`
        },
        timeoutMs: 1000
      }
    },
    reviewProviders: ["codex", "agy"]
  });
  await seedRelayConfig(projectRoot, recoveredConfig);
  const resumed = await resume({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(resumed.exitClass, "human-action-required");
  assert.match(resumed.reason, /delivery is not configured/);
});

test("delivery uses neutral team-facing text, parses gh stdout URLs, clears dirty state, and cleanup removes only approved clean worktrees", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore();
  const gitStorePath = await createFakeGitStore(projectRoot);
  const gateStorePath = await createFakeGateStore([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  const shimDir = await createGateShimPath();
  const ghStorePath = await createFakeGhStore();
  const coderStore = await createFakeProviderStore([
    {
      type: "success",
      writes: [{ path: "src/deliver.ts", content: "export const deliver = true;\n" }],
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: ["src/deliver.ts"],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([
    successReviewStep(),
    successReviewStep()
  ]);
  const secondReviewerStore = await createFakeProviderStore([
    successReviewStep(),
    successReviewStep()
  ]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: coderStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      codex: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: reviewerStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      agy: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: secondReviewerStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      }
    },
    reviewProviders: ["codex", "agy"],
    github: {
      command: repoPath("test", "fixtures", "fake-gh.mjs"),
      env: {
        FAKE_GH_STORE: ghStorePath
      }
    },
    delivery: {
      enabled: true,
      identity: {
        name: "Relay User",
        email: "relay@example.com"
      }
    },
    cleanup: {
      allowDestructive: true
    }
  });
  await seedRelayConfig(projectRoot, config);
  await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, ghStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  const reviewResult = await review({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, ghStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(reviewResult.ok, true);
  assert.match(reviewResult.prUrl, /^https:\/\/relay\.test\/pr\//);
  const gitStore = JSON.parse(await readFile(gitStorePath, "utf8"));
  assert.deepEqual(gitStore.records.staged[0].paths, ["src/deliver.ts"]);
  assert.equal(gitStore.records.commits[0].args.includes("-a"), false);
  assert.equal(gitStore.records.pushes[0].args.includes("--force"), false);
  const commitMessage = gitStore.records.commits[0].args[gitStore.records.commits[0].args.indexOf("-m") + 1];
  assert.doesNotMatch(commitMessage, /example-app-123|claude|codex|agy/);
  const ghStore = JSON.parse(await readFile(ghStorePath, "utf8"));
  assert.equal(ghStore.prs[0].args.includes("--json"), false);
  assert.doesNotMatch(ghStore.prs[0].title, /example-app-123|claude|codex|agy/);
  assert.match(ghStore.prs[0].body, /## What/);
  assert.match(ghStore.prs[0].body, /## Changes/);
  assert.match(ghStore.prs[0].body, /## Evidence/);
  assert.doesNotMatch(ghStore.prs[0].body, /example-app-123|claude|codex|agy/);
  assert.equal(reviewResult.state.dirtyWorktree, false);
  const cleanupResult = await cleanup({ projectRoot, adapterName: "example-app", beadId: "example-app-123" });
  assert.equal(cleanupResult.ok, true);
  const removed = JSON.parse(await readFile(gitStorePath, "utf8"));
  assert.equal(removed.records.removals.length, 1);
  assert.equal(removed.records.prunes.length, 1);
});

test("run does not bypass plan review quorum for non-documentation work", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore();
  const gitStorePath = await createFakeGitStore(projectRoot);
  const gateStorePath = await createFakeGateStore([]);
  const shimDir = await createGateShimPath();
  const coderStore = await createFakeProviderStore([
    {
      type: "success",
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: [],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: coderStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      codex: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: reviewerStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      agy: null
    },
    reviewProviders: ["codex"]
  });
  await seedRelayConfig(projectRoot, config);
  const result = await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(result.exitClass, "provider-quorum-unavailable");
  const coderCalls = JSON.parse(await readFile(coderStore, "utf8")).calls.length;
  assert.equal(coderCalls, 0);
});

test("high-risk plans require matching approval comments and resume advances on the correct specHash", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Money path bead",
        description: "Handle a high-risk path.",
        design: "Use the guarded route only.",
        acceptance_criteria: "Plan review and approval must complete before implementation.",
        riskClass: "money-path",
        dependencies: [],
        claimed: false,
        claimConflict: false
      }
    }
  });
  const gitStorePath = await createFakeGitStore(projectRoot);
  const gateStorePath = await createFakeGateStore([{ ok: true }]);
  const shimDir = await createGateShimPath();
  const coderStore = await createFakeProviderStore([
    {
      type: "success",
      report: {
        status: "success",
        summary: "implemented high risk change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: [],
        artifacts: []
      }
    }
  ]);
  const codexStore = await createFakeProviderStore([successReviewStep()]);
  const agyStore = await createFakeProviderStore([successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: coderStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      codex: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: codexStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      agy: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: agyStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      }
    },
    reviewProviders: ["codex", "agy"]
  });
  await seedRelayConfig(projectRoot, config);
  const planResult = await plan({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(planResult.exitClass, "human-action-required");
  assert.equal(planResult.state.planReview.completed, true);
  assert.deepEqual(planResult.state.planReview.reviewers, ["codex", "agy"]);
  const specHash = planResult.state.specHash;
  await mutateBdStore(bdStorePath, (store) => {
    store.comments["example-app-123"].push({
      text: JSON.stringify({ kind: "agent-relay-plan-approval", specHash: "deadbeef", approved: true })
    });
  });
  const blocked = await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(blocked.exitClass, "human-action-required");
  assert.match(blocked.reason, /matching specHash/);
  await mutateBdStore(bdStorePath, (store) => {
    store.comments["example-app-123"].push({
      text: JSON.stringify({ kind: "agent-relay-plan-approval", specHash, approved: true })
    });
  });
  const resumed = await resume({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(resumed.ok, true);
  const coderCalls = JSON.parse(await readFile(coderStore, "utf8")).calls.length;
  assert.equal(coderCalls, 1);
});

test("review corrections return to the same coder and include consolidated findings in the next prompt", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Docs bead",
        description: "Implement the requested change set.",
        design: "Follow the current architecture and preserve safety boundaries.",
        acceptance_criteria: "Tests pass after reviewer-requested fixes.",
        riskClass: "documentation",
        dependencies: [],
        claimed: false,
        claimConflict: false
      }
    }
  });
  const gitStorePath = await createFakeGitStore(projectRoot);
  const gateStorePath = await createFakeGateStore([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  const shimDir = await createGateShimPath();
  const coderStore = await createFakeProviderStore([
    {
      type: "success",
      writes: [{ path: "src/reviewable.ts", content: "export const reviewable = true;\n" }],
      report: {
        status: "success",
        summary: "first pass",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: ["src/reviewable.ts"],
        artifacts: []
      }
    },
    {
      type: "success",
      writes: [{ path: "src/reviewable.ts", content: "export const reviewable = 2;\n" }],
      report: {
        status: "success",
        summary: "addressed findings",
        ownedPaths: ["."],
        commandsAttempted: ["node implement-fix.js"],
        changedPaths: ["src/reviewable.ts"],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([
    successReviewStep(),
    successReviewStep("missing guard", [{ severity: "high", title: "Need extra guard", file: "src/reviewable.ts" }])
  ]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: coderStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      },
      codex: null,
      agy: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: reviewerStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      }
    },
    reviewProviders: ["agy"]
  });
  await seedRelayConfig(projectRoot, config);
  const runResult = await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(runResult.ok, true);
  const reviewResult = await review({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(reviewResult.ok, true);
  const coderCalls = JSON.parse(await readFile(coderStore, "utf8")).calls;
  assert.equal(coderCalls.length, 2);
  assert.equal(coderCalls[0].cwd, coderCalls[1].cwd);
  assert.match(coderCalls[1].prompt, /Need extra guard/);
  assert.match(coderCalls[1].prompt, /missing guard/);
  assert.equal(reviewResult.state.pendingCorrection, null);
});

test("run fails closed when the coder mutates the worktree branch", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Docs bead",
        description: "Implement the requested change set.",
        design: "Follow the current architecture and preserve safety boundaries.",
        acceptance_criteria: "Tests pass.",
        riskClass: "documentation",
        dependencies: [],
        claimed: false,
        claimConflict: false
      }
    }
  });
  const gitStorePath = await createFakeGitStore(projectRoot);
  const gateStorePath = await createFakeGateStore([{ ok: true }]);
  const shimDir = await createGateShimPath();
  const coderStore = await createFakeProviderStore([
    {
      type: "success",
      gitDrift: { branch: "relay/drifted" },
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: [],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: {
          FAKE_PROVIDER_STORE: coderStore,
          FAKE_GIT_STORE: gitStorePath,
          PATH: `${shimDir}:${process.env.PATH}`
        },
        timeoutMs: 1000
      },
      codex: null,
      agy: {
        command: process.execPath,
        args: [repoPath("test", "fixtures", "fake-provider.mjs")],
        env: { FAKE_PROVIDER_STORE: reviewerStore, PATH: `${shimDir}:${process.env.PATH}` },
        timeoutMs: 1000
      }
    },
    reviewProviders: ["agy"]
  });
  await seedRelayConfig(projectRoot, config);
  await assert.rejects(
    () =>
      run({
        projectRoot,
        adapterName: "example-app",
        beadId: "example-app-123",
        env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
      }),
    /worktree branch drift/
  );
});

test("manual gates return human-action-required for human-only groups", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const result = await gates({
    projectRoot,
    adapterName: "example-app",
    gateName: "browser-walkthroughs"
  });
  assert.equal(result.exitClass, "human-action-required");
  assert.equal(result.results[0].status, "human-action-required");
});

test("cleanup preserves dirty worktrees even when destructive cleanup is approved", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const gitStorePath = await createFakeGitStore(projectRoot);
  const config = baseConfig(projectRoot, gitStorePath, {
    cleanup: {
      allowDestructive: true
    }
  });
  await seedRelayConfig(projectRoot, config);
  const dirtyWorktreePath = path.join(path.dirname(projectRoot), "dirty-worktree");
  await writeState(projectRoot, "example-app-123", {
    beadId: "example-app-123",
    phase: "complete",
    dirtyWorktree: true,
    worktreePath: dirtyWorktreePath
  });
  const cleanupResult = await cleanup({ projectRoot, adapterName: "example-app", beadId: "example-app-123" });
  assert.equal(cleanupResult.exitClass, "human-action-required");
  assert.match(cleanupResult.reason, /dirty or partially committed worktrees/);
});
