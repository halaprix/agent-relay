import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { loadAdapter } from "../src/lib/adapter.mjs";
import { acquireLock } from "../src/lib/lock.mjs";
import { projectStateRoot, repoPath, runStatePath } from "../src/lib/paths.mjs";
import { pathExists, removePath } from "../src/lib/fs.mjs";
import {
  __prepareIsolatedProviderRunForTests,
  __resetBubblewrapSupportForTests,
  __resetTestIsolationRunnerForTests,
  __setBubblewrapSupportForTests,
  __setTestIsolationRunnerForTests,
  cleanup,
  doctor,
  gates,
  plan,
  resume,
  review,
  run,
  setup,
  status
} from "../src/lib/supervisor.mjs";
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

const execFile = promisify(execFileCallback);

__setTestIsolationRunnerForTests(true);
test.after(() => {
  __resetTestIsolationRunnerForTests();
  __resetBubblewrapSupportForTests();
});

function relayEnv({ bdStorePath, gateStorePath, gitStorePath, ghStorePath, extra = {} }) {
  return {
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

function fakeProviderConfig({ storePath, shimDir, vendor, strength = "strong", extraEnv = {}, timeoutMs = 1000 }) {
  return {
    command: process.execPath,
    args: [repoPath("test", "fixtures", "fake-provider.mjs")],
    env: {
      FAKE_PROVIDER_STORE: storePath,
      PATH: `${shimDir}:${process.env.PATH}`,
      ...extraEnv
    },
    timeoutMs,
    vendor,
    strength
  };
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

function indexOfMount(args, targetPath) {
  for (let index = 0; index < args.length - 2; index += 1) {
    if ((args[index] === "--bind" || args[index] === "--ro-bind") && args[index + 2] === targetPath) {
      return index;
    }
  }
  return -1;
}

async function mutateBdStore(storePath, mutate) {
  const store = JSON.parse(await readFile(storePath, "utf8"));
  mutate(store);
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return store;
}

async function runGitCommand(cwd, args) {
  await execFile("git", args, { cwd });
}

async function createRealGitProjectFixture() {
  const projectRoot = await createProjectFixture();
  await rm(path.join(projectRoot, ".git"), { recursive: true, force: true });
  await runGitCommand(projectRoot, ["init", "-b", "dev"]);
  await runGitCommand(projectRoot, ["config", "user.name", "Relay Tester"]);
  await runGitCommand(projectRoot, ["config", "user.email", "relay-tester@example.com"]);
  await runGitCommand(projectRoot, ["add", "."]);
  await runGitCommand(projectRoot, ["commit", "-m", "fixture"]);
  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), "agent-relay-remote-"));
  await runGitCommand(remoteRoot, ["init", "--bare"]);
  await runGitCommand(projectRoot, ["remote", "add", "origin", remoteRoot]);
  await runGitCommand(projectRoot, ["push", "-u", "origin", "dev"]);
  return { projectRoot, remoteRoot };
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

test("setup creates the ignored reference cache and the project-local beads exclude entry", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const result = await setup({ projectRoot, adapterName: "example-app" });
  assert.equal(result.ok, true);
  assert.equal(result.resourcesRoot, path.join(projectRoot, ".resources"));
  assert.equal(result.beadsDir, path.join(projectRoot, ".beads"));
  assert.equal(result.beadsTracked, true);
  const cacheReadme = await readFile(path.join(projectRoot, ".resources", "README.md"), "utf8");
  assert.match(cacheReadme, /never-committed cache/);
  assert.match(cacheReadme, /SOURCE\.md/);
  const exclude = await readFile(path.join(projectRoot, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.resources\/$/m);
  assert.doesNotMatch(exclude, /^\.beads\/$/m);

  await mkdir(path.join(projectRoot, ".resources", "beads"), { recursive: true });
  await writeFile(path.join(projectRoot, ".resources", "beads", "SOURCE.md"), "cached\n", "utf8");
  const rerun = await setup({ projectRoot, adapterName: "example-app" });
  assert.equal(rerun.ok, true);
  const excludeAfter = await readFile(path.join(projectRoot, ".git", "info", "exclude"), "utf8");
  assert.equal(excludeAfter.split("\n").filter((line) => line === ".resources/").length, 1);
  assert.equal(await readFile(path.join(projectRoot, ".resources", "beads", "SOURCE.md"), "utf8"), "cached\n");
});

test("run and plan refuse a container bead and name the leaves beneath it", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const gitStorePath = await createFakeGitStore(projectRoot);
  const bdStorePath = await createFakeBdStore({
    projectRoot,
    children: {
      "example-app-123": [
        { id: "example-app-123.1", title: "Parse usage", status: "open" },
        { id: "example-app-123.2", title: "Old slice", status: "closed" }
      ]
    }
  });
  await seedRelayConfig(projectRoot, baseConfig(projectRoot, gitStorePath));
  const env = relayEnv({ bdStorePath, gitStorePath });

  for (const [label, invoke] of [["run", run], ["plan", plan]]) {
    const result = await invoke({ projectRoot, adapterName: "example-app", beadId: "example-app-123", env });
    assert.equal(result.exitClass, "project-misconfigured", label);
    assert.match(result.reason, /container/i);
    assert.match(result.reason, /example-app-123\.1/);
    // The closed child is listed as history but must not be offered as a target.
    assert.doesNotMatch(result.reason, /example-app-123\.2/);
    assert.equal(result.children.length, 2);
  }

  // A leaf with no children is untouched by the check.
  const leafChildren = await createFakeBdStore({ projectRoot });
  const leafResult = await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath: leafChildren, gitStorePath })
  });
  assert.notEqual(leafResult.exitClass, "project-misconfigured");
});

test("status groups runs under their epic", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  await writeState(projectRoot, "example-app-n95.1", { beadId: "example-app-n95.1", phase: "complete" });
  await writeState(projectRoot, "example-app-n95.2", { beadId: "example-app-n95.2", phase: "implementing" });
  await writeState(projectRoot, "example-app-6st", { beadId: "example-app-6st", phase: "planning" });

  const result = await status({ projectRoot });
  assert.equal(result.runs.length, 3);
  const groups = Object.fromEntries(result.groups.map((group) => [group.epic, group.beadIds]));
  assert.deepEqual(groups["example-app-n95"], ["example-app-n95.1", "example-app-n95.2"]);
  assert.deepEqual(groups["example-app-6st"], ["example-app-6st"]);
});

test("doctor honors the requested adapter and validates required files", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const result = await doctor({ projectRoot, adapterName: "example-app", env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.adapter, "example-app");
  assert.equal(result.beadsDir, path.join(projectRoot, ".beads"));
  assert.equal(result.beadsStorePresent, true);
  assert.equal(result.resourcesIgnored, true);
  assert.equal(result.inheritedBeadsDirIgnored, false);
});

test("doctor reports a missing project-local beads store and an ignored global BEADS_DIR", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  await rm(path.join(projectRoot, ".beads"), { recursive: true, force: true });
  const result = await doctor({
    projectRoot,
    adapterName: "example-app",
    env: { BEADS_DIR: "/home/someone/.global-beads" }
  });
  assert.equal(result.exitClass, "project-misconfigured");
  assert.equal(result.problems.some((problem) => /missing beads store/.test(problem)), true);
  assert.equal(result.problems.some((problem) => /bd init --quiet/.test(problem)), true);
  assert.equal(result.inheritedBeadsDirIgnored, true);
});

test("isolated provider runs mount the project reference cache read-only", { timeout: 10000 }, async (t) => {
  __setBubblewrapSupportForTests(true);
  t.after(() => __resetBubblewrapSupportForTests());
  const projectRoot = await createProjectFixture();
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-relay-isolated-worktree-"));
  const gitStorePath = await createFakeGitStore(projectRoot);
  const shimDir = await createGateShimPath();
  const providerStorePath = await createFakeProviderStore([]);
  const { adapter } = await loadAdapter("example-app");
  await setup({ projectRoot, adapterName: "example-app" });
  await mkdir(path.join(projectRoot, ".resources", "beads"), { recursive: true });
  await writeFile(path.join(projectRoot, ".resources", "beads", "SOURCE.md"), "cached reference\n", "utf8");

  const isolated = await __prepareIsolatedProviderRunForTests({
    projectRoot,
    adapter,
    config: baseConfig(projectRoot, gitStorePath),
    supervisorEnv: relayEnv({ gitStorePath }),
    providerConfig: fakeProviderConfig({ storePath: providerStorePath, shimDir, vendor: "anthropic" }),
    beadId: "example-app-123",
    providerName: "claude",
    cwd: worktreeRoot,
    writableRoot: worktreeRoot,
    promptContents: "test prompt"
  });

  const resourcesRoot = await realpath(path.join(projectRoot, ".resources"));
  const resourcesMountIndex = indexOfMount(isolated.args, resourcesRoot);
  assert.notEqual(resourcesMountIndex, -1);
  assert.equal(isolated.args[resourcesMountIndex], "--ro-bind");
  assert.equal(isolated.env.AGENT_RELAY_RESOURCES_DIR, resourcesRoot);

  const beadsMountIndex = indexOfMount(isolated.args, await realpath(path.join(projectRoot, ".beads")));
  assert.notEqual(beadsMountIndex, -1);
  assert.equal(isolated.args[beadsMountIndex], "--ro-bind");
});

test("prepareIsolatedProviderRun requires explicit vendor metadata and builds bubblewrap mounts with share-net, readonly blockers, and a writable sandbox HOME", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({ projectRoot });
  const requiredBeadsDir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-beads-required-"));
  const gitStorePath = await createFakeGitStore(projectRoot);
  const shimDir = await createGateShimPath();
  const providerStorePath = await createFakeProviderStore([]);
  const { adapter } = await loadAdapter("example-app");
  const testAdapter = {
    ...adapter,
    beads: {
      ...adapter.beads,
      requiredDir: requiredBeadsDir
    }
  };
  const config = baseConfig(projectRoot, gitStorePath);
  const supervisorEnv = relayEnv({ bdStorePath, gitStorePath, extra: { BEADS_DIR: requiredBeadsDir } });
  const reviewArtifactSource = path.join(await mkdtemp(path.join(os.tmpdir(), "agent-relay-review-artifact-")), "reviewed.json");
  await writeFile(reviewArtifactSource, '{"artifact":true}\n', "utf8");

  await assert.rejects(
    () =>
      __prepareIsolatedProviderRunForTests({
        projectRoot,
        adapter: testAdapter,
        config,
        supervisorEnv,
        providerConfig: {
          command: process.execPath,
          args: [repoPath("test", "fixtures", "fake-provider.mjs")],
          env: {
            FAKE_PROVIDER_STORE: providerStorePath,
            PATH: `${shimDir}:${process.env.PATH}`
          }
        },
        beadId: "example-app-123",
        providerName: "claude",
        cwd: projectRoot,
        writableRoot: projectRoot,
        promptContents: "test prompt"
      }),
    /vendor must be configured explicitly/
  );

  __setBubblewrapSupportForTests(true);
  try {
    const isolated = await __prepareIsolatedProviderRunForTests({
      projectRoot,
      adapter: testAdapter,
      config,
      supervisorEnv,
      providerConfig: {
        ...fakeProviderConfig({
          storePath: providerStorePath,
          shimDir,
          vendor: "Anthropic"
        }),
        runtime: {
          readOnlyMounts: [shimDir]
        }
      },
      beadId: "example-app-123",
      providerName: "claude",
      cwd: projectRoot,
      writableRoot: projectRoot,
      copiedArtifacts: [
        {
          sourcePath: reviewArtifactSource,
          fileName: "review-artifact.json"
        }
      ],
      promptBuilder: (bundle) => `Prompt path: ${bundle.promptPath}\nArtifact path: ${bundle.files.get("review-artifact.json")}`
    });

    assert.equal(isolated.command, "/usr/bin/bwrap");
    assert.match(isolated.env.HOME, new RegExp(`^${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.agent-relay-sandbox/`));
    assert.equal(isolated.args.includes("--share-net"), true);
    assert.equal(isolated.env.BEADS_DIR, requiredBeadsDir);
    assert.equal(isolated.env.AGENT_RELAY_BD_BIN, repoPath("test", "fixtures", "fake-bd.mjs"));
    const runtimeMountIndex = indexOfMount(isolated.args, shimDir);
    assert.notEqual(runtimeMountIndex, -1);
    assert.equal(isolated.args[runtimeMountIndex], "--ro-bind");
    const beadsMountIndex = indexOfMount(isolated.args, requiredBeadsDir);
    assert.notEqual(beadsMountIndex, -1);
    assert.equal(isolated.args[beadsMountIndex], "--ro-bind");
    const bdMountIndex = indexOfMount(isolated.args, repoPath("test", "fixtures", "fake-bd.mjs"));
    assert.notEqual(bdMountIndex, -1);
    assert.equal(isolated.args[bdMountIndex], "--ro-bind");
    assert.equal(isolated.args.at(-1), isolated.promptPath);
    assert.match(await readFile(isolated.promptPath, "utf8"), /Artifact path: /);
    const promptContents = await readFile(isolated.promptPath, "utf8");
    const artifactPath = promptContents.match(/Artifact path: (.+)\n?$/m)?.[1];
    assert.equal(typeof artifactPath, "string");
    assert.equal(await pathExists(artifactPath), true);
    assert.equal(await pathExists(path.join(isolated.bundleRoot, "review-artifact.json")), true);
    assert.equal(isolated.args[isolated.args.indexOf("--chdir") + 1], projectRoot);
    assert.notEqual(indexOfMount(isolated.args, projectRoot), -1);

    const blockedGitTarget = repoPath("test", "fixtures", "fake-git-driver.mjs");
    const blockedGitMountIndex = indexOfMount(isolated.args, blockedGitTarget);
    assert.notEqual(blockedGitMountIndex, -1);
    assert.equal(isolated.args[blockedGitMountIndex], "--ro-bind");

    await assert.rejects(
      () =>
        __prepareIsolatedProviderRunForTests({
          projectRoot,
          adapter: testAdapter,
          config,
          supervisorEnv,
          providerConfig: {
            ...fakeProviderConfig({
              storePath: providerStorePath,
              shimDir,
              vendor: "anthropic"
            }),
            runtime: {
              readOnlyMounts: [projectRoot]
            }
          },
          beadId: "example-app-123",
          providerName: "claude",
          cwd: projectRoot,
          writableRoot: projectRoot,
          promptContents: "test prompt"
        }),
      /cannot overlap protected project, worktree, Beads, or control-plane paths/
    );

    await assert.rejects(
      () =>
        __prepareIsolatedProviderRunForTests({
          projectRoot,
          adapter: testAdapter,
          config,
          supervisorEnv,
          providerConfig: {
            ...fakeProviderConfig({
              storePath: providerStorePath,
              shimDir,
              vendor: "anthropic"
            }),
            runtime: {
              readOnlyMounts: ["/"]
            }
          },
          beadId: "example-app-123",
          providerName: "claude",
          cwd: projectRoot,
          writableRoot: projectRoot,
          promptContents: "test prompt"
        }),
      /cannot overlap protected project, worktree, Beads, or control-plane paths/
    );

    await assert.rejects(
      () =>
        __prepareIsolatedProviderRunForTests({
          projectRoot,
          adapter: testAdapter,
          config,
          supervisorEnv,
          providerConfig: {
            ...fakeProviderConfig({
              storePath: providerStorePath,
              shimDir,
              vendor: "anthropic"
            }),
            runtime: {
              readOnlyMounts: [path.dirname(projectRoot)]
            }
          },
          beadId: "example-app-123",
          providerName: "claude",
          cwd: projectRoot,
          writableRoot: projectRoot,
          promptContents: "test prompt"
        }),
      /cannot overlap protected project, worktree, Beads, or control-plane paths/
    );

    await assert.rejects(
      () =>
        __prepareIsolatedProviderRunForTests({
          projectRoot,
          adapter: testAdapter,
          config,
          supervisorEnv,
          providerConfig: {
            ...fakeProviderConfig({
              storePath: providerStorePath,
              shimDir,
              vendor: "anthropic"
            }),
            runtime: {
              readOnlyMounts: [`${projectRoot}${path.sep}`]
            }
          },
          beadId: "example-app-123",
          providerName: "claude",
          cwd: projectRoot,
          writableRoot: projectRoot,
          promptContents: "test prompt"
        }),
      /cannot overlap protected project, worktree, Beads, or control-plane paths/
    );

    const dotDotRuntimeAncestor = await mkdtemp(path.join(os.tmpdir(), "agent-relay-dotdot-runtime-"));
    const dotDotRuntimeRoot = path.join(dotDotRuntimeAncestor, "protected-root");
    const dotDotRuntimeChild = path.join(dotDotRuntimeRoot, "..runtime");
    const dotDotRuntimeSibling = path.join(dotDotRuntimeAncestor, "runtime");
    await mkdir(dotDotRuntimeRoot, { recursive: true });
    await mkdir(dotDotRuntimeChild, { recursive: true });
    await mkdir(dotDotRuntimeSibling, { recursive: true });

    await assert.rejects(
      () =>
        __prepareIsolatedProviderRunForTests({
          projectRoot,
          adapter: testAdapter,
          config,
          supervisorEnv,
          providerConfig: {
            ...fakeProviderConfig({
              storePath: providerStorePath,
              shimDir,
              vendor: "anthropic"
            }),
            runtime: {
              readOnlyMounts: [dotDotRuntimeChild]
            }
          },
          beadId: "example-app-123",
          providerName: "claude",
          cwd: dotDotRuntimeRoot,
          writableRoot: dotDotRuntimeRoot,
          promptContents: "test prompt"
        }),
      /cannot overlap protected project, worktree, Beads, or control-plane paths/
    );

    const siblingIsolated = await __prepareIsolatedProviderRunForTests({
      projectRoot,
      adapter: testAdapter,
      config,
      supervisorEnv,
      providerConfig: {
        ...fakeProviderConfig({
          storePath: providerStorePath,
          shimDir,
          vendor: "anthropic"
        }),
        runtime: {
          readOnlyMounts: [dotDotRuntimeSibling]
        }
      },
      beadId: "example-app-123",
      providerName: "claude",
      cwd: dotDotRuntimeRoot,
      writableRoot: dotDotRuntimeRoot,
      promptContents: "test prompt"
    });
    assert.notEqual(indexOfMount(siblingIsolated.args, dotDotRuntimeSibling), -1);

    const externalGitRoot = await mkdtemp(path.join(os.tmpdir(), "agent-relay-external-git-"));
    const externalGitDir = path.join(externalGitRoot, "worktrees", "wt");
    const externalCommonDir = path.join(externalGitRoot, "common");
    const externalWorktreeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-relay-external-worktree-"));
    await mkdir(externalGitDir, { recursive: true });
    await mkdir(externalCommonDir, { recursive: true });
    await writeFile(path.join(externalGitDir, "commondir"), "../../common\n", "utf8");
    await rm(path.join(externalWorktreeRoot, ".git"), { recursive: true, force: true });
    await writeFile(path.join(externalWorktreeRoot, ".git"), `gitdir: ${externalGitDir}\n`, "utf8");
    await assert.rejects(
      () =>
        __prepareIsolatedProviderRunForTests({
          projectRoot,
          adapter: testAdapter,
          config,
          supervisorEnv,
          providerConfig: {
            ...fakeProviderConfig({
              storePath: providerStorePath,
              shimDir,
              vendor: "anthropic"
            }),
            runtime: {
              readOnlyMounts: [externalGitRoot]
            }
          },
          beadId: "example-app-123",
          providerName: "claude",
          cwd: externalWorktreeRoot,
          writableRoot: externalWorktreeRoot,
          promptContents: "test prompt"
        }),
      /cannot overlap protected project, worktree, Beads, or control-plane paths/
    );
  } finally {
    __resetBubblewrapSupportForTests();
  }
});

test("run creates an isolated worktree and executes the coder there", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    projectRoot,
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
      claude: fakeProviderConfig({ storePath: providerStorePath, shimDir, vendor: "anthropic" }),
      codex: null,
      agy: fakeProviderConfig({ storePath: reviewerStorePath, shimDir, vendor: "google" })
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
  assert.match(providerStore.calls[0].prompt, /Gate groups: none/);
  assert.match(providerStore.calls[0].prompt, /AGENT_RELAY_RESOURCES_DIR/);
  assert.match(providerStore.calls[0].prompt, /never project law and never a deliverable/);
  assert.doesNotMatch(providerStore.calls[0].prompt, /formatting|solidity/);
});

test("run strips BEADS_DIR from providers and blocks absolute command and write escapes", { timeout: 10000 }, async (t) => {
  __setBubblewrapSupportForTests(false);
  t.after(() => __resetBubblewrapSupportForTests());
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    projectRoot,
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Isolation bead",
        description: "Verify provider containment.",
        design: "Contain providers to the assigned worktree only.",
        acceptance_criteria: "Providers cannot access Beads or escape the writable root.",
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
  const escapePath = path.join(path.dirname(projectRoot), "provider-escape.txt");
  const providerStorePath = await createFakeProviderStore([
    {
      type: "success",
      captureEnv: true,
      absoluteWritePath: escapePath,
      execAbsoluteCommand: repoPath("test", "fixtures", "fake-git-driver.mjs"),
      execAbsoluteArgs: ["status", "--short"],
      writes: [{ path: "src/isolation.ts", content: "export const isolation = true;\n" }],
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: ["src/isolation.ts"],
        artifacts: []
      }
    }
  ]);
  const reviewerStorePath = await createFakeProviderStore([successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: fakeProviderConfig({
        storePath: providerStorePath,
        shimDir,
        vendor: "anthropic",
        extraEnv: {
          FAKE_GIT_STORE: gitStorePath
        }
      }),
      codex: null,
      agy: fakeProviderConfig({ storePath: reviewerStorePath, shimDir, vendor: "google" })
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
  assert.equal(result.exitClass, "provider-quorum-unavailable");
  assert.match(result.reason, /no provider could complete implementation/);
  const providerStore = JSON.parse(await readFile(providerStorePath, "utf8"));
  assert.equal(providerStore.calls[0].env.BEADS_DIR, null);
  assert.equal(providerStore.calls[0].env.AGENT_RELAY_BD_BIN, null);
  assert.equal(providerStore.calls[0].absoluteWrite.ok, false);
  assert.match(providerStore.calls[0].absoluteWrite.message, /blocked write outside writable root/);
  assert.equal(providerStore.calls[0].absoluteCommand.code, 1);
  assert.match(providerStore.calls[0].absoluteCommand.stderr, /blocked executable/);
  assert.equal(await pathExists(escapePath), false);
});

test("run retries service failure once, corrects on needs-fix with the same provider, and preserves partial edits across handoff", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    projectRoot,
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
  const reviewerStore = await createFakeProviderStore([successReviewStep(), successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: fakeProviderConfig({ storePath: claudeStore, shimDir, vendor: "anthropic" }),
      codex: fakeProviderConfig({ storePath: codexStore, shimDir, vendor: "openai" }),
      agy: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "google" })
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
    projectRoot,
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
  const reviewerStore = await createFakeProviderStore([successReviewStep(), successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: fakeProviderConfig({ storePath: providerStore, shimDir, vendor: "anthropic" }),
      codex: null,
      agy: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "google" })
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
  const bdStorePath = await createFakeBdStore({ projectRoot });
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
      claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "anthropic" }),
      codex: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "openai" }),
      agy: fakeProviderConfig({ storePath: secondPlanReviewerStore, shimDir, vendor: "google" })
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
      agy: fakeProviderConfig({
        storePath: await createFakeProviderStore([
          successReviewStep()
        ]),
        shimDir,
        vendor: "google"
      })
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

test("delivery uses neutral team-facing text, parses gh stdout URLs, clears dirty state, and cleanup removes only approved clean worktrees", { timeout: 30000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({ projectRoot });
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
      claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "anthropic" }),
      codex: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "openai" }),
      agy: fakeProviderConfig({ storePath: secondReviewerStore, shimDir, vendor: "google" })
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

test("delivery binds the reviewed artifact to the staged index even if the worktree mutates after add", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    projectRoot,
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Staged artifact bead",
        description: "Bind reviewed content to the staged index.",
        design: "Stage explicit paths and reject drift.",
        acceptance_criteria: "The committed index stays on the reviewed content.",
        riskClass: "documentation",
        dependencies: [],
        claimed: false,
        claimConflict: false
      }
    }
  });
  const gitStorePath = await createFakeGitStore(projectRoot, {
    postAddMutation: {
      path: "src/staged.ts",
      content: "export const staged = 2;\n"
    }
  });
  const ghStorePath = await createFakeGhStore();
  const gateStorePath = await createFakeGateStore([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }]);
  const shimDir = await createGateShimPath();
  const coderStore = await createFakeProviderStore([
    {
      type: "success",
      writes: [{ path: "src/staged.ts", content: "export const staged = 1;\n" }],
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: ["src/staged.ts"],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([successReviewStep(), successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "anthropic" }),
      codex: null,
      agy: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "google" })
    },
    reviewProviders: ["agy"],
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
    }
  });
  await seedRelayConfig(projectRoot, config);
  const runResult = await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, ghStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(runResult.ok, true);
  const reviewResult = await review({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, ghStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(reviewResult.ok, true);
  const gitStore = JSON.parse(await readFile(gitStorePath, "utf8"));
  const stagedPaths = gitStore.records.staged.at(-1).paths;
  assert.deepEqual(stagedPaths, ["src/staged.ts"]);
  assert.equal(
    Buffer.from(gitStore.worktrees[reviewResult.state.worktreePath].index["src/staged.ts"].contentBase64, "base64").toString("utf8"),
    "export const staged = 1;\n"
  );
  assert.equal(gitStore.worktrees[reviewResult.state.worktreePath].index["src/staged.ts"].mode, "100644");
  assert.equal(await readFile(path.join(reviewResult.state.worktreePath, "src", "staged.ts"), "utf8"), "export const staged = 2;\n");
});

test("resume reparses metadata.agentRelay JSON and invalidates stale recovered approvals when the spec changes", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    projectRoot,
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Metadata recovery bead",
        description: "Recover state from Bead comments.",
        design: "Use metadata-driven policy.",
        acceptance_criteria: "Changed metadata invalidates stale approval state.",
        riskClass: "documentation",
        metadata: {
          agentRelay: JSON.stringify({
            riskClass: "money-path",
            ownedPaths: ["src/alpha.ts"],
            gateGroups: ["sdk-package"]
          })
        },
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
        ownedPaths: ["src/alpha.ts"],
        commandsAttempted: ["node implement.js"],
        changedPaths: [],
        artifacts: []
      }
    }
  ]);
  const codexStore = await createFakeProviderStore([successReviewStep(), successReviewStep()]);
  const agyStore = await createFakeProviderStore([successReviewStep(), successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "anthropic" }),
      codex: fakeProviderConfig({ storePath: codexStore, shimDir, vendor: "openai" }),
      agy: fakeProviderConfig({ storePath: agyStore, shimDir, vendor: "google" })
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
  assert.deepEqual(planResult.state.ownedPaths, ["src/alpha.ts"]);
  const oldSpecHash = planResult.state.specHash;
  await mutateBdStore(bdStorePath, (store) => {
    store.comments["example-app-123"].push({
      text: JSON.stringify({ kind: "agent-relay-plan-approval", specHash: oldSpecHash, approved: true })
    });
    store.issues["example-app-123"].metadata.agentRelay = JSON.stringify({
      riskClass: "money-path",
      ownedPaths: ["src/beta.ts"],
      gateGroups: ["app-package"]
    });
  });
  await removePath(runStatePath(projectRoot, "example-app-123"));
  const resumed = await resume({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(resumed.exitClass, "human-action-required");
  assert.deepEqual(resumed.state.ownedPaths, ["src/beta.ts"]);
  assert.notEqual(resumed.state.specHash, oldSpecHash);
  assert.equal(resumed.state.planReview.completed, true);
  assert.match(resumed.reason, /matching specHash|agent-relay-plan-approval/);
});

test("delivery routing uses default groups for documentation and normal code, and the override for solidity-core", { timeout: 40000 }, async () => {
  async function deliverForRisk(riskClass) {
    const projectRoot = await createProjectFixture();
    const bdStorePath = await createFakeBdStore({
    projectRoot,
      issues: {
        "example-app-123": {
          id: "example-app-123",
          title: `${riskClass} bead`,
          description: "Exercise delivery routing.",
          design: "Route delivery gates by risk class.",
          acceptance_criteria: "The expected gate groups run.",
          riskClass,
          dependencies: [],
          claimed: false,
          claimConflict: false
        }
      }
    });
    const gitStorePath = await createFakeGitStore(projectRoot);
    const ghStorePath = await createFakeGhStore();
    const gateStorePath = await createFakeGateStore(Array.from({ length: 8 }, () => ({ ok: true })));
    const shimDir = await createGateShimPath();
    const coderStore = await createFakeProviderStore([
      {
        type: "success",
        writes: [{ path: `src/${riskClass}.ts`, content: `export const risk = ${JSON.stringify(riskClass)};\n` }],
        report: {
          status: "success",
          summary: "implemented change",
          ownedPaths: ["."],
          commandsAttempted: ["node implement.js"],
          changedPaths: [`src/${riskClass}.ts`],
          artifacts: []
        }
      }
    ]);
    const openaiReviewStore = await createFakeProviderStore([successReviewStep(), successReviewStep(), successReviewStep()]);
    const googleReviewStore = await createFakeProviderStore([successReviewStep(), successReviewStep(), successReviewStep()]);
    const config = baseConfig(projectRoot, gitStorePath, {
      planApprovalRiskClasses: [],
      providers: {
        claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "anthropic" }),
        codex: fakeProviderConfig({ storePath: openaiReviewStore, shimDir, vendor: "openai" }),
        agy: fakeProviderConfig({ storePath: googleReviewStore, shimDir, vendor: "google" })
      },
      reviewProviders: riskClass === "documentation" ? ["codex"] : ["codex", "agy"],
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
      }
    });
    await seedRelayConfig(projectRoot, config);
    const runResult = await run({
      projectRoot,
      adapterName: "example-app",
      beadId: "example-app-123",
      env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, ghStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
    });
    assert.equal(runResult.ok, true);
    const reviewResult = await review({
      projectRoot,
      adapterName: "example-app",
      beadId: "example-app-123",
      env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, ghStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
    });
    assert.equal(reviewResult.ok, true);
    return reviewResult.state.gateResults.map((gate) => gate.group);
  }

  const documentationGroups = await deliverForRisk("documentation");
  const normalGroups = await deliverForRisk("normal-code");
  const solidityGroups = await deliverForRisk("solidity-core");

  assert.equal(documentationGroups.includes("solidity"), false);
  assert.deepEqual(normalGroups, documentationGroups);
  assert.equal(solidityGroups.includes("solidity"), true);
  assert.equal(solidityGroups.filter((group) => group === "solidity").length, 2);
});

test("run does not bypass plan review quorum for non-documentation work", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({ projectRoot });
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
      claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "anthropic" }),
      codex: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "openai" }),
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

test("review vendor independence rejects same-vendor aliases as independent reviewers", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    projectRoot,
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Vendor independence bead",
        description: "Require distinct reviewer vendors.",
        design: "Exclude reviewers from the coder vendor and collapse aliases.",
        acceptance_criteria: "Same-vendor aliases do not count toward review quorum.",
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
      writes: [{ path: "src/vendor-independence.ts", content: "export const vendorIndependence = true;\n" }],
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: ["src/vendor-independence.ts"],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([successReviewStep()]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "OpenAI" }),
      codex: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "openai" }),
      agy: null
    },
    reviewProviders: ["codex"]
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
  assert.equal(reviewResult.exitClass, "provider-quorum-unavailable");
  assert.match(reviewResult.reason, /need 1 distinct review vendors, found 0/);
});

test("high-risk plans require matching approval comments and resume advances on the correct specHash", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const bdStorePath = await createFakeBdStore({
    projectRoot,
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
      claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "anthropic" }),
      codex: fakeProviderConfig({ storePath: codexStore, shimDir, vendor: "openai" }),
      agy: fakeProviderConfig({ storePath: agyStore, shimDir, vendor: "google" })
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
    projectRoot,
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
  const ghStorePath = await createFakeGhStore();
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
    successReviewStep("missing guard", [{ severity: "high", title: "Need extra guard", file: "src/reviewable.ts" }]),
    successReviewStep("re-review clean")
  ]);
  const config = baseConfig(projectRoot, gitStorePath, {
    providers: {
      claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "anthropic" }),
      codex: null,
      agy: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "google" })
    },
    reviewProviders: ["agy"],
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
    }
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
    env: relayEnv({ bdStorePath, gateStorePath, gitStorePath, ghStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
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
    projectRoot,
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
      claude: fakeProviderConfig({
        storePath: coderStore,
        shimDir,
        vendor: "anthropic",
        extraEnv: {
          FAKE_GIT_STORE: gitStorePath
        }
      }),
      codex: null,
      agy: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "google" })
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

test("run and resume reject a fresh concurrent bead lock", { timeout: 10000 }, async () => {
  const projectRoot = await createProjectFixture();
  const lockDir = path.join(projectStateRoot(projectRoot), "locks");
  await mkdir(lockDir, { recursive: true });
  const lock = await acquireLock({
    lockPath: path.join(lockDir, "example-app-123.lock.json"),
    owner: "run:999"
  });
  assert.equal(lock.acquired, true);

  try {
    const runResult = await run({
      projectRoot,
      adapterName: "example-app",
      beadId: "example-app-123"
    });
    assert.equal(runResult.exitClass, "human-action-required");
    assert.match(runResult.reason, /locked by another run/);

    const resumeResult = await resume({
      projectRoot,
      adapterName: "example-app",
      beadId: "example-app-123"
    });
    assert.equal(resumeResult.exitClass, "human-action-required");
    assert.match(resumeResult.reason, /locked by another run/);
  } finally {
    await lock.release();
  }
});

test("review fails closed when a reviewer mutates a real git worktree", { timeout: 15000 }, async () => {
  const { projectRoot } = await createRealGitProjectFixture();
  const bdStorePath = await createFakeBdStore({
    projectRoot,
    issues: {
      "example-app-123": {
        id: "example-app-123",
        title: "Real git review",
        description: "Use a real git worktree for mutation checks.",
        design: "Reviewers must not mutate the worktree.",
        acceptance_criteria: "Mutation is rejected.",
        riskClass: "documentation",
        dependencies: [],
        claimed: false,
        claimConflict: false
      }
    }
  });
  const gateStorePath = await createFakeGateStore([]);
  const shimDir = await createGateShimPath();
  const coderStore = await createFakeProviderStore([
    {
      type: "success",
      writes: [{ path: "src/real-review.ts", content: "export const realReview = true;\n" }],
      report: {
        status: "success",
        summary: "implemented change",
        ownedPaths: ["."],
        commandsAttempted: ["node implement.js"],
        changedPaths: ["src/real-review.ts"],
        artifacts: []
      }
    }
  ]);
  const reviewerStore = await createFakeProviderStore([
    successReviewStep(),
    {
      type: "success",
      writes: [{ path: "src/reviewer-mutation.ts", content: "export const mutated = true;\n" }],
      report: {
        status: "success",
        summary: "clean review",
        findings: [],
        commandsAttempted: ["node review.js"]
      }
    }
  ]);
  const config = {
    adapter: "example-app",
    mainCheckoutRoot: projectRoot,
    correctionLimit: 2,
    planApprovalRiskClasses: ["money-path", "solidity-core", "shared-infrastructure"],
    providers: {
      claude: fakeProviderConfig({ storePath: coderStore, shimDir, vendor: "anthropic" }),
      codex: null,
      agy: fakeProviderConfig({ storePath: reviewerStore, shimDir, vendor: "google" })
    },
    reviewProviders: ["agy"],
    pluginMaintenanceMode: false,
    git: {
      command: "git",
      env: {},
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
    delivery: null
  };
  await seedRelayConfig(projectRoot, config);
  const runResult = await run({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    env: relayEnv({ bdStorePath, gateStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
  });
  assert.equal(runResult.ok, true);
  await assert.rejects(
    () =>
      review({
        projectRoot,
        adapterName: "example-app",
        beadId: "example-app-123",
        env: relayEnv({ bdStorePath, gateStorePath, extra: { PATH: `${shimDir}:${process.env.PATH}` } })
      }),
    /reviewer mutated worktree contents/
  );
});
