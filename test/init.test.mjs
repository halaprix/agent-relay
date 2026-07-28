import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { validateAdapter } from "../src/lib/adapter.mjs";
import { buildAdapterFromFacts, detectProjectFacts, init, slugify } from "../src/lib/init.mjs";
import { projectStateRoot, repoPath } from "../src/lib/paths.mjs";
import { readJson } from "../src/lib/fs.mjs";
import { cleanupFixtures, createFakeBdStore, fixtureDir } from "./helpers.mjs";

const execFile = promisify(execFileCallback);

test.after(cleanupFixtures);

async function gitInit(dir) {
  await execFile("git", ["init", "--quiet"], { cwd: dir });
}

async function writeFileDeep(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

// relay init exists so a project's adapter is authored by detection and a summary to
// review, not by copying adapters/example-app.json and hand-editing gate commands that
// came from a project this one is not. These tests verify the two things that matter
// most: it never produces an adapter that fails validateAdapter, no matter how little
// was detected, and the one thing it cannot leave to guesswork - a project that
// forgot to configure anything - degrades to a safe, working default rather than
// crashing or emitting nonsense.

test("slugify handles a scoped package name, a bare name, and nothing at all", () => {
  assert.equal(slugify("@acme/widget-service"), "acme-widget-service");
  assert.equal(slugify("Plain Name"), "plain-name");
  assert.equal(slugify(""), "project");
  assert.equal(slugify(undefined), "project");
});

test("detectProjectFacts finds a single package's test script with no workspaces field", async () => {
  const projectRoot = await fixtureDir("agent-relay-init-single-");
  await gitInit(projectRoot);
  await writeFileDeep(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "@acme/widget", scripts: { test: "node --test", lint: "eslint ." } })
  );
  await writeFile(path.join(projectRoot, "package-lock.json"), "{}", "utf8");

  const facts = await detectProjectFacts(projectRoot);
  assert.equal(facts.packageManager, "npm");
  assert.equal(facts.packages.length, 1);
  assert.equal(facts.packages[0].name, "@acme/widget");
  assert.equal(facts.packages[0].dir, ".");
});

test("detectProjectFacts expands a simple workspaces glob and finds Foundry", async () => {
  const projectRoot = await fixtureDir("agent-relay-init-monorepo-");
  await gitInit(projectRoot);
  await writeFileDeep(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*"] })
  );
  await writeFile(path.join(projectRoot, "pnpm-lock.yaml"), "", "utf8");
  await writeFileDeep(
    path.join(projectRoot, "packages", "sdk", "package.json"),
    JSON.stringify({ name: "@acme/sdk", scripts: { test: "vitest run" } })
  );
  await writeFileDeep(path.join(projectRoot, "packages", "contracts", "foundry.toml"), "");

  const facts = await detectProjectFacts(projectRoot);
  assert.equal(facts.packageManager, "pnpm");
  assert.deepEqual(
    facts.packages.map((pkg) => pkg.name),
    ["@acme/sdk"]
  );
  assert.deepEqual(facts.foundryRoots, ["packages/contracts"]);
});

test("detectProjectFacts reports an unsupported workspace glob rather than mishandling it", async () => {
  const projectRoot = await fixtureDir("agent-relay-init-exotic-glob-");
  await gitInit(projectRoot);
  await writeFileDeep(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/**"] })
  );
  const facts = await detectProjectFacts(projectRoot);
  assert.equal(facts.warnings.length, 1);
  assert.match(facts.warnings[0], /not a plain "dir\/\*" glob/);
});

test("agent-relay's own .agents/agent-relay/ state does not make agy look configured", async () => {
  // The bug this pins: agy's projectDir is [".agents", "agents"], and agent-relay's own
  // local state also lives under ".agents" (.agents/agent-relay/) regardless of whether
  // agy is in use. Checking only the bare top segment would read agy as configured on
  // every project the moment relay itself has run once - reproduced here directly by
  // creating exactly that directory and nothing agy-specific.
  const projectRoot = await fixtureDir("agent-relay-init-agy-collision-");
  await gitInit(projectRoot);
  await mkdir(path.join(projectStateRoot(projectRoot)), { recursive: true });
  await mkdir(path.join(projectRoot, ".claude"), { recursive: true });

  const facts = await detectProjectFacts(projectRoot);
  assert.equal(facts.providerDirs.agy, false);
  assert.equal(facts.providerDirs.claude, true);
});

test("a genuinely synced agy role directory is still detected", async () => {
  const projectRoot = await fixtureDir("agent-relay-init-agy-real-");
  await gitInit(projectRoot);
  await mkdir(path.join(projectRoot, ".agents", "agents"), { recursive: true });
  const facts = await detectProjectFacts(projectRoot);
  assert.equal(facts.providerDirs.agy, true);
});

test("buildAdapterFromFacts always produces a valid adapter, even when nothing was detected", () => {
  const bareFacts = {
    packageManager: null,
    packages: [],
    foundryRoots: [],
    providerDirs: { claude: false, codex: false, agy: false, opencode: false },
    docsArchitecturePresent: false,
    docsAdrPresent: false,
    agentsFilePresent: false,
    stateFilePresent: false,
    prTemplatePresent: false,
    baseBranch: "main",
    defaultName: "bare-project",
    warnings: []
  };
  const adapter = buildAdapterFromFacts(bareFacts, {});
  assert.doesNotThrow(() => validateAdapter(adapter));
  assert.deepEqual(adapter.gates.groups, {});
  assert.deepEqual(adapter.gates.routing.implementationDefault, []);
  assert.deepEqual(adapter.riskClasses, {
    documentation: { reviewVendors: 1, strongReviewersOnly: false },
    "normal-code": { reviewVendors: 2, strongReviewersOnly: false }
  });
});

test("buildAdapterFromFacts wires a detected package and Foundry into a valid adapter", () => {
  const facts = {
    packageManager: "pnpm",
    packages: [
      { dir: "packages/app", name: "@acme/app", scripts: { test: "vitest run", lint: "eslint ." } },
      { dir: "packages/sdk", name: "@acme/sdk", scripts: { test: "vitest run" } }
    ],
    foundryRoots: ["packages/contracts"],
    providerDirs: { claude: true, codex: false, agy: false, opencode: false },
    docsArchitecturePresent: true,
    docsAdrPresent: false,
    agentsFilePresent: true,
    stateFilePresent: false,
    prTemplatePresent: false,
    baseBranch: "dev",
    defaultName: "acme",
    warnings: []
  };
  const adapter = buildAdapterFromFacts(facts, {});
  validateAdapter(adapter);
  assert.equal(adapter.repository.baseBranch, "dev");
  assert.deepEqual(adapter.providers.providerOrder, ["claude"]);
  assert.ok(adapter.riskClasses["solidity-core"]);
  assert.deepEqual(adapter.gates.routing.deliveryByRisk["solidity-core"], [
    "acme-app-package",
    "acme-sdk-package",
    "solidity"
  ]);
  assert.deepEqual(adapter.guidance.architectureRoots, ["docs/architecture"]);
  assert.deepEqual(adapter.guidance.requiredFiles, ["AGENTS.md"]);
});

test("an explicit --providers overrides detection entirely", () => {
  const facts = {
    packageManager: null,
    packages: [],
    foundryRoots: [],
    providerDirs: { claude: true, codex: false, agy: false, opencode: false },
    docsArchitecturePresent: false,
    docsAdrPresent: false,
    agentsFilePresent: false,
    stateFilePresent: false,
    prTemplatePresent: false,
    baseBranch: "main",
    defaultName: "x",
    warnings: []
  };
  const adapter = buildAdapterFromFacts(facts, { providers: ["codex", "agy"] });
  assert.deepEqual(adapter.providers.providerOrder, ["codex", "agy"]);
});

test("init writes an adapter, never overwrites without --force, and validates end to end", async () => {
  const projectRoot = await fixtureDir("agent-relay-init-e2e-");
  await gitInit(projectRoot);
  await mkdir(path.join(projectRoot, ".claude"), { recursive: true });

  const first = await init({ projectRoot, name: "e2e-project", env: {} });
  assert.equal(first.ok, true);
  assert.equal(first.memorySeeded, false, "no beads store existed, so nothing to seed");

  const written = await readJson(first.adapterPath);
  validateAdapter(written);
  assert.equal(written.name, "e2e-project");

  const again = await init({ projectRoot, name: "different-name", env: {} });
  assert.equal(again.ok, false);
  assert.equal(again.exitClass, "project-misconfigured");
  assert.match(again.error, /already exists/);
  // Refused, so the file must be exactly what it was.
  assert.equal((await readJson(first.adapterPath)).name, "e2e-project");

  const forced = await init({ projectRoot, name: "different-name", force: true, env: {} });
  assert.equal(forced.ok, true);
  assert.equal((await readJson(first.adapterPath)).name, "different-name");
});

test("init seeds the required bd memory, scoped to the project's own store, when one is present", { timeout: 10000 }, async () => {
  const projectRoot = await fixtureDir("agent-relay-init-memory-");
  await gitInit(projectRoot);
  // A real .beads directory is what beadsStorePresent checks for on disk; the fake shim
  // stands in for `bd` itself, matching how the rest of this suite avoids depending on a
  // real `bd` binary being on PATH in CI.
  await mkdir(path.join(projectRoot, ".beads"), { recursive: true });
  const storePath = await createFakeBdStore({ projectRoot });
  const env = {
    AGENT_RELAY_BD_BIN: repoPath("test", "fixtures", "fake-bd.mjs"),
    FAKE_BD_STORE: storePath,
    PATH: process.env.PATH
  };

  const outcome = await init({ projectRoot, name: "memory-project", env });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.memorySeeded, true);

  const adapter = await readJson(outcome.adapterPath);
  const store = await readJson(storePath);
  assert.equal(store.memoriesRemembered.length, 1);
  assert.equal(store.memoriesRemembered[0].key, adapter.beads.memoryKey);
  assert.equal(store.memoriesRemembered[0].key, "memory-project-agent-relay-bootstrap");
  assert.match(store.memoriesRemembered[0].content, /generated by `relay init`/);
});

test("init reports no beads store present as a clear next step, not a silent skip", { timeout: 10000 }, async () => {
  const projectRoot = await fixtureDir("agent-relay-init-no-store-");
  await gitInit(projectRoot);
  const outcome = await init({ projectRoot, name: "no-store-project", env: {} });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.memorySeeded, false);
  assert.ok(
    outcome.summary.some((line) => line.includes("bd remember") && line.includes(outcome.adapter)),
    "the summary must name the exact memory key a human still needs to seed"
  );
});
