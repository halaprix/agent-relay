import path from "node:path";
import { readdir, readFile, writeFile, mkdtemp, rename } from "node:fs/promises";
import os from "node:os";
import { loadAdapter, syncAdapters } from "./adapter.mjs";
import { appendBeadComment, approvalForSpecHash, rebuildStateFromBeadComments, verifyBeadsStore } from "./beads.mjs";
import { ensureDir, pathExists, readJson, writeJson, appendJsonl, removePath, listFilesRecursive } from "./fs.mjs";
import {
  buildScopeLockedDiffArtifact,
  captureSnapshot,
  createDetachedWorktree,
  getGitBranch,
  getGitHead,
  getGitRemotes,
  getGitStatus,
  removeWorktree,
  resolveBaseSha,
} from "./git.mjs";
import { assertCommandsAllowed, assertOwnedPaths, scanPrivacyInPaths } from "./guardrails.mjs";
import { sha256Json, sha256Text } from "./hash.mjs";
import { acquireLock } from "./lock.mjs";
import { ok, result } from "./output.mjs";
import {
  projectConfigPath,
  projectStateRoot,
  runLedgerPath,
  runStatePath
} from "./paths.mjs";
import { classifyProviderFailure, parseWorkerReport, runProviderCommand } from "./provider.mjs";
import { assertTeamFacingTextClean, sanitizeIssueForPrompt, sanitizePromptText, sanitizeTeamFacingText, slugifyTitle } from "./sanitize.mjs";
import { syncRoleBundles } from "./roles.mjs";
import { validateReviewReport, validateWorkerReport } from "./validate.mjs";

function nowIso() {
  return new Date().toISOString();
}

async function writeJsonAtomic(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

function shortSpecHash(specHash) {
  return specHash.slice(0, 8);
}

function neutralNames(issueTitle, specHash) {
  const cleanTitle = sanitizeTeamFacingText(issueTitle);
  const slug = slugifyTitle(cleanTitle);
  const suffix = shortSpecHash(specHash);
  return {
    slug,
    branch: `relay/${slug}-${suffix}`,
    commitMessage: sanitizeTeamFacingText(`relay ${cleanTitle} ${suffix}`),
    prTitle: sanitizeTeamFacingText(`relay ${cleanTitle} ${suffix}`)
  };
}

function computeSpecHash(bead) {
  return sha256Json({
    description: bead.description || "",
    design: bead.design || "",
    acceptance: bead.acceptance_criteria || bead.acceptance || "",
    dependencies: bead.dependencies || [],
    riskClass: bead.riskClass || "normal-code",
    ownedPaths: bead.ownedPaths || ["."],
    gateGroups: bead.gateGroups || []
  });
}

function defaultPlanReview(config, riskClass, specHash) {
  return {
    completed: false,
    findingsResolved: false,
    reviewers: [],
    findings: [],
    approvalRequired: (config.planApprovalRiskClasses || []).includes(riskClass || "normal-code"),
    approvalSpecHash: specHash
  };
}

function lockPathForBead(projectRoot, beadId) {
  return path.join(projectStateRoot(projectRoot), "locks", `${beadId}.lock.json`);
}

function defaultConfig(adapterName, projectRoot) {
  return {
    adapter: adapterName,
    mainCheckoutRoot: projectRoot,
    worktreeRoot: path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-agent-relay-worktrees`),
    correctionLimit: 2,
    planApprovalRiskClasses: ["money-path", "solidity-core", "shared-infrastructure"],
    providers: {
      claude: null,
      codex: null,
      agy: null
    },
    reviewProviders: ["claude", "codex", "agy"],
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
      command: "gh",
      env: {}
    },
    delivery: null,
    cleanup: {
      allowDestructive: false
    }
  };
}

async function readProjectConfig(projectRoot, adapterName) {
  const configPath = projectConfigPath(projectRoot);
  if (!(await pathExists(configPath))) {
    const config = defaultConfig(adapterName, projectRoot);
    await writeJson(configPath, config);
    return config;
  }
  return readJson(configPath);
}

async function ensureGitExclude(projectRoot) {
  const excludePath = path.join(projectRoot, ".git", "info", "exclude");
  if (!(await pathExists(path.dirname(excludePath)))) {
    return null;
  }
  const current = (await readFile(excludePath, "utf8").catch(() => "")).split("\n");
  const marker = ".agents/agent-relay/";
  if (!current.includes(marker)) {
    const next = `${current.filter(Boolean).join("\n")}${current.length > 1 ? "\n" : ""}${marker}\n`;
    await writeFile(excludePath, next, "utf8");
  }
  return excludePath;
}

async function ensureProjectState(projectRoot, adapterName) {
  const stateRoot = projectStateRoot(projectRoot);
  await ensureDir(path.join(stateRoot, "state"));
  await ensureDir(path.join(stateRoot, "artifacts"));
  await ensureDir(path.join(stateRoot, "worktrees"));
  const config = await readProjectConfig(projectRoot, adapterName);
  const excludePath = await ensureGitExclude(projectRoot);
  return { config, excludePath, stateRoot };
}

async function syncProjectRoles(projectRoot) {
  const outputs = await syncRoleBundles();
  const syncedRoles = [];
  const targets = [
    { provider: "claude", dir: path.join(projectRoot, ".claude", "agents"), ext: "md", key: "claude" },
    { provider: "codex", dir: path.join(projectRoot, ".codex", "agents"), ext: "toml", key: "codex" },
    { provider: "agy", dir: path.join(projectRoot, ".agents", "agents"), ext: "md", key: "agy" }
  ];
  for (const target of targets) {
    if (!(await pathExists(path.dirname(target.dir)))) {
      continue;
    }
    await ensureDir(target.dir);
    for (const output of outputs) {
      const destination = path.join(target.dir, `${output.role}.${target.ext}`);
      await writeFile(destination, output[target.key], "utf8");
      syncedRoles.push(path.relative(projectRoot, destination));
    }
  }
  return syncedRoles.sort();
}

async function writeState(projectRoot, beadId, patch) {
  const filePath = runStatePath(projectRoot, beadId);
  const current = (await pathExists(filePath)) ? await readJson(filePath) : {};
  const next = {
    ...current,
    ...patch,
    timestamps: {
      createdAt: current.timestamps?.createdAt || nowIso(),
      updatedAt: nowIso()
    }
  };
  await writeJsonAtomic(filePath, next);
  return next;
}

async function appendLedger(projectRoot, beadId, event, payload) {
  await appendJsonl(runLedgerPath(projectRoot, beadId), {
    at: nowIso(),
    event,
    payload
  });
}

async function appendCheckpoint({ projectRoot, beadId, env, label, statePatch, details = {} }) {
  await appendLedger(projectRoot, beadId, label, { statePatch, details });
  appendBeadComment({
    env,
    beadId,
    comment: {
      kind: "agent-relay-checkpoint",
      at: nowIso(),
      label,
      statePatch,
      details
    }
  });
}

async function readTextIfExists(filePath) {
  return readFile(filePath, "utf8").catch(() => "");
}

async function sha256Files(rootDir) {
  if (!(await pathExists(rootDir))) {
    return "";
  }
  const files = await listFilesRecursive(rootDir);
  const sections = [];
  for (const filePath of files) {
    sections.push(`${path.relative(rootDir, filePath)}:${sha256Text(await readTextIfExists(filePath))}`);
  }
  return sha256Text(sections.join("\n"));
}

async function runGitText(config, cwd, args) {
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

async function captureControlPlaneSnapshot(config, projectRoot, worktreePath) {
  const snapshot = {
    mainStatus: await getGitStatus(config, config.mainCheckoutRoot || projectRoot),
    mainHead: await getGitHead(config, config.mainCheckoutRoot || projectRoot),
    mainBranch: await getGitBranch(config, config.mainCheckoutRoot || projectRoot),
    remotes: await getGitRemotes(config, config.mainCheckoutRoot || projectRoot),
    refs: await runGitText(config, config.mainCheckoutRoot || projectRoot, ["show-ref", "--head"]),
    gitConfigHash: sha256Text(await readTextIfExists(path.join(config.mainCheckoutRoot || projectRoot, ".git", "config"))),
    hooksHash: await sha256Files(path.join(config.mainCheckoutRoot || projectRoot, ".git", "hooks"))
  };
  if (worktreePath && await pathExists(worktreePath)) {
    snapshot.worktreeHead = await getGitHead(config, worktreePath);
    snapshot.worktreeBranch = await getGitBranch(config, worktreePath);
  }
  return snapshot;
}

function assertStableControlPlane(before, after, label, {
  allowMainStatusChange = false,
  allowRemoteChange = false,
  allowHeadChange = false,
  allowBranchChange = false
} = {}) {
  if (!allowMainStatusChange && before.mainStatus !== after.mainStatus) {
    throw new Error(`main checkout drift detected during ${label}`);
  }
  if (before.mainHead !== after.mainHead) {
    throw new Error(`main checkout HEAD drift detected during ${label}`);
  }
  if (before.mainBranch !== after.mainBranch) {
    throw new Error(`main checkout branch drift detected during ${label}`);
  }
  if (!allowRemoteChange && before.remotes !== after.remotes) {
    throw new Error(`remote mutation detected during ${label}`);
  }
  if (before.refs !== after.refs) {
    throw new Error(`ref mutation detected during ${label}`);
  }
  if (before.gitConfigHash !== after.gitConfigHash) {
    throw new Error(`git config mutation detected during ${label}`);
  }
  if (before.hooksHash !== after.hooksHash) {
    throw new Error(`git hooks mutation detected during ${label}`);
  }
  if ("worktreeHead" in before && !allowHeadChange && before.worktreeHead !== after.worktreeHead) {
    throw new Error(`worktree HEAD drift detected during ${label}`);
  }
  if ("worktreeBranch" in before && !allowBranchChange && before.worktreeBranch !== after.worktreeBranch) {
    throw new Error(`worktree branch drift detected during ${label}`);
  }
}

function providerCommandFromConfig(config, providerName) {
  const provider = config.providers?.[providerName];
  return provider?.command ? provider : null;
}

function providerVendor(providerName, providerConfig) {
  return providerConfig?.vendor || providerName;
}

function providerStrength(providerConfig) {
  return providerConfig?.strength || "strong";
}

async function createProviderPathShim({ beadId, providerName, allowReadOnlyGit = false }) {
  const shimDir = await mkdtemp(path.join(os.tmpdir(), `agent-relay-shim-${beadId}-${providerName}-`));
  const denyBody = (name) => `#!/usr/bin/env bash\necho "${name} is blocked by agent-relay supervision" >&2\nexit 1\n`;
  await writeFile(path.join(shimDir, "bd"), denyBody("bd"), { mode: 0o755 });
  await writeFile(path.join(shimDir, "gh"), denyBody("gh"), { mode: 0o755 });
  const gitBody = allowReadOnlyGit
    ? `#!/usr/bin/env bash\ncase "$1" in\n  rev-parse|show-ref|symbolic-ref|status|config|remote)\n    command git "$@"\n    ;;\n  *)\n    echo "git mutation is blocked by agent-relay supervision" >&2\n    exit 1\n    ;;\nesac\n`
    : denyBody("git");
  await writeFile(path.join(shimDir, "git"), gitBody, { mode: 0o755 });
  return shimDir;
}

async function buildProviderExecutionEnv({ providerConfig, beadId, providerName, mode }) {
  const pathValue = providerConfig.env?.PATH || process.env.PATH;
  if (!pathValue) {
    throw new Error(`provider containment is unavailable for ${providerName}`);
  }
  const shimDir = await createProviderPathShim({
    beadId,
    providerName,
    allowReadOnlyGit: mode === "read-only"
  });
  const env = {
    ...(providerConfig.env || {}),
    PATH: `${shimDir}:${pathValue}`
  };
  delete env.BEADS_DIR;
  delete env.AGENT_RELAY_BEADS_READONLY;
  return env;
}

function candidateReviewProviders({ config, providerNames, requiredVendors, excludedVendor = null, strongOnly = false }) {
  const candidates = [];
  const seenVendors = new Set();
  for (const providerName of providerNames) {
    const providerConfig = providerCommandFromConfig(config, providerName);
    if (!providerConfig) {
      continue;
    }
    const vendor = providerVendor(providerName, providerConfig);
    if (excludedVendor && vendor === excludedVendor) {
      continue;
    }
    if (strongOnly && providerStrength(providerConfig) !== "strong") {
      continue;
    }
    if (seenVendors.has(vendor)) {
      continue;
    }
    seenVendors.add(vendor);
    candidates.push({ providerName, providerConfig, vendor });
  }
  return {
    candidates,
    hasQuorum: candidates.length >= requiredVendors
  };
}

async function runCommandChecked({
  config,
  projectRoot,
  cwd,
  worktreePath,
  command,
  args = [],
  env = {},
  timeoutMs,
  label,
  allowMainStatusChange = false,
  allowRemoteChange = false,
  allowHeadChange = false,
  allowBranchChange = false
}) {
  const before = await captureControlPlaneSnapshot(config, projectRoot, worktreePath);
  const run = await runProviderCommand({
    providerName: label,
    command,
    args,
    cwd,
    env,
    timeoutMs
  });
  const after = await captureControlPlaneSnapshot(config, projectRoot, worktreePath);
  assertStableControlPlane(before, after, label, {
    allowMainStatusChange,
    allowRemoteChange,
    allowHeadChange,
    allowBranchChange
  });
  return run;
}

async function runSetupCommands({ adapter, config, projectRoot, worktreePath }) {
  const [command, ...args] = adapter.repository.worktreeSetupCommand;
  const run = await runCommandChecked({
    config,
    projectRoot,
    cwd: worktreePath,
    worktreePath,
    command,
    args,
    timeoutMs: 30 * 60 * 1000,
    label: "worktree-setup"
  });
  if (run.code !== 0) {
    throw new Error(`worktree setup failed: ${run.stderr || run.stdout}`);
  }
  return run;
}

function computeReviewVendorPolicy(adapter, riskClass) {
  const resolvedRisk = riskClass && adapter.riskClasses[riskClass] ? riskClass : "normal-code";
  return {
    riskClass: resolvedRisk,
    ...adapter.riskClasses[resolvedRisk]
  };
}

function gateGroupsForPhase(adapter, phase, riskClass) {
  const routing = adapter.gates.routing || {};
  if (phase === "implementation") {
    return routing.implementationByRisk?.[riskClass] || routing.implementationDefault || ["types-and-tests"];
  }
  if (phase === "delivery") {
    return routing.deliveryFull || ["pre-push"];
  }
  if (phase === "human-approval") {
    return routing.humanApproval || [];
  }
  return [];
}

function uniqueProviders(names) {
  return [...new Set(names)];
}

function parsePrUrl(output) {
  const match = output.match(/https?:\/\/\S+/);
  if (!match) {
    throw new Error("unable to parse PR URL from gh output");
  }
  return match[0];
}

function consolidateFindings(findings) {
  return findings
    .flatMap((item) => item.report.findings.map((finding) => ({
      severity: finding.severity,
      title: finding.title,
      file: finding.file || ""
    })))
    .map((finding) => `${finding.severity}: ${finding.title}${finding.file ? ` (${finding.file})` : ""}`)
    .join("\n");
}

function buildCorrectionReason(findings) {
  const summaries = findings
    .map((item) => item.report.summary)
    .filter(Boolean)
    .join("\n");
  const consolidated = consolidateFindings(findings);
  return [summaries, consolidated].filter(Boolean).join("\n");
}

function buildPlanState({ projectRoot, adapterName, bead, config }) {
  const sanitizedIssue = sanitizeIssueForPrompt(bead);
  const specHash = computeSpecHash(bead);
  const names = neutralNames(sanitizedIssue.title, specHash);
  return {
    beadId: bead.id,
    adapterName,
    projectRoot,
    phase: "planning",
    riskClass: bead.riskClass || "normal-code",
    issue: sanitizedIssue,
    specHash,
    ownedPaths: Array.isArray(bead.ownedPaths) && bead.ownedPaths.length > 0 ? bead.ownedPaths : ["."],
    prohibitedActions: [
      "git mutation by worker",
      "beads write by worker",
      "remote mutation",
      "force push"
    ],
    gateGroups: bead.gateGroups || [],
    providerCursor: {
      coderIndex: 0,
      reviewProvidersTried: []
    },
    correctionRounds: 0,
    pendingCorrection: null,
    planReview: defaultPlanReview(config, bead.riskClass || "normal-code", specHash),
    reviewState: {
      requiredVendors: 2,
      completedVendors: [],
      findingsResolved: false
    },
    neutralNames: names,
    delivery: {
      prUrl: null
    }
  };
}

async function ensurePlannedState({ projectRoot, adapterName, beadId, adapter, env, config }) {
  const statePath = runStatePath(projectRoot, beadId);
  const hasLocalState = await pathExists(statePath);
  const beads = verifyBeadsStore({ adapter, env, beadId, claim: false, alreadyClaimed: true });
  const livePlan = buildPlanState({
    projectRoot,
    adapterName,
    bead: { ...beads.bead, _adapterRiskClasses: adapter.riskClasses },
    config
  });
  if (hasLocalState) {
    const current = await readJson(statePath);
    if (current.specHash !== livePlan.specHash) {
      return writeState(projectRoot, beadId, {
        ...current,
        ...livePlan,
        phase: "planning",
        planReview: defaultPlanReview(config, livePlan.riskClass, livePlan.specHash),
        reviewState: {
          requiredVendors: computeReviewVendorPolicy(adapter, livePlan.riskClass).reviewVendors,
          completedVendors: [],
          findingsResolved: false
        },
        correctionRounds: 0,
        pendingCorrection: null,
        delivery: { prUrl: null }
      });
    }
    return writeState(projectRoot, beadId, {
      ...current,
      issue: livePlan.issue,
      riskClass: livePlan.riskClass,
      ownedPaths: livePlan.ownedPaths,
      gateGroups: livePlan.gateGroups,
      specHash: livePlan.specHash,
      neutralNames: livePlan.neutralNames,
      planReview: {
        ...(current.planReview || defaultPlanReview(config, livePlan.riskClass, livePlan.specHash)),
        approvalRequired: livePlan.planReview.approvalRequired,
        approvalSpecHash: livePlan.specHash
      }
    });
  }
  if (!beads.bead.claimed) {
    verifyBeadsStore({ adapter, env, beadId, claim: true, alreadyClaimed: false });
  }
  const policy = computeReviewVendorPolicy(adapter, beads.bead.riskClass);
  const state = livePlan;
  state.reviewState.requiredVendors = policy.reviewVendors;
  const planned = await writeState(projectRoot, beadId, {
    ...state,
    claimed: true
  });
  await appendCheckpoint({
    projectRoot,
    beadId,
    env,
    label: "planned",
    statePatch: planned,
    details: {
      riskClass: state.riskClass,
      reviewVendors: policy.reviewVendors
    }
  });
  return planned;
}

async function loadOrRecoverState({ projectRoot, adapterName, beadId, adapter, env, config }) {
  const localPath = runStatePath(projectRoot, beadId);
  if (await pathExists(localPath)) {
    return ensurePlannedState({ projectRoot, adapterName, beadId, adapter, env, config });
  }
  const beads = verifyBeadsStore({ adapter, env, beadId, claim: false, alreadyClaimed: true });
  const liveState = buildPlanState({
    projectRoot,
    adapterName,
    bead: { ...beads.bead, _adapterRiskClasses: adapter.riskClasses },
    config
  });
  liveState.reviewState.requiredVendors = computeReviewVendorPolicy(adapter, beads.bead.riskClass).reviewVendors;
  const recovered = rebuildStateFromBeadComments(beads.checkpoints);
  if (!recovered.beadId) {
    return ensurePlannedState({ projectRoot, adapterName, beadId, adapter, env, config });
  }
  const state = await writeState(projectRoot, beadId, {
    ...liveState,
    ...recovered
  });
  await appendLedger(projectRoot, beadId, "state-recovered", { source: "bead-comments" });
  return state;
}

async function createWorktreeIfMissing({ projectRoot, beadId, adapter, config, state, env }) {
  if (state.worktreePath && await pathExists(state.worktreePath)) {
    return state;
  }
  const before = await getGitStatus(config, config.mainCheckoutRoot || projectRoot);
  const baseSha = await resolveBaseSha(config, projectRoot, adapter.repository.baseBranch);
  const worktreePath = path.join(
    config.worktreeRoot || path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-agent-relay-worktrees`),
    `${state.neutralNames.slug}-${shortSpecHash(state.specHash)}`
  );
  const branch = state.neutralNames.branch;
  await createDetachedWorktree(config, projectRoot, worktreePath, baseSha, branch);
  await runSetupCommands({ adapter, config, projectRoot, worktreePath });
  const after = await getGitStatus(config, config.mainCheckoutRoot || projectRoot);
  if (before !== after) {
    throw new Error("main checkout drift detected during worktree creation");
  }
  const snapshot = await captureSnapshot(worktreePath, { ignorePrefixes: [".git", ".agents/agent-relay"] });
  const snapshotPath = path.join(projectStateRoot(projectRoot), "artifacts", beadId, "setup-snapshot.json");
  await ensureDir(path.dirname(snapshotPath));
  await writeJson(snapshotPath, snapshot);
  const nextState = await writeState(projectRoot, beadId, {
    ...state,
    phase: state.phase === "planning" ? "implementing" : state.phase,
    baseSha,
    baseBranch: adapter.repository.baseBranch,
    branch,
    worktreePath,
    setupComplete: true,
    snapshotPath
  });
  await appendCheckpoint({
    projectRoot,
    beadId,
    env,
    label: "worktree-created",
    statePatch: {
      baseSha,
      baseBranch: adapter.repository.baseBranch,
      branch,
      worktreePath,
      setupComplete: true,
      snapshotPath
    }
  });
  return nextState;
}

async function snapshotForState(state) {
  return state.snapshotPath ? readJson(state.snapshotPath) : {};
}

async function writeProviderPrompt({ projectRoot, beadId, fileName, contents }) {
  const filePath = path.join(projectStateRoot(projectRoot), "artifacts", beadId, fileName);
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${contents}\n`, "utf8");
  return filePath;
}

async function withBeadLock({ projectRoot, beadId, action }, fn) {
  const lock = await acquireLock({
    lockPath: lockPathForBead(projectRoot, beadId),
    owner: `${action}:${process.pid}`,
    staleMs: 2000,
    heartbeatMs: 200
  });
  if (!lock.acquired) {
    return result("human-action-required", action, {
      reason: `bead ${beadId} is locked by another run`,
      lock: lock.currentLock || null
    });
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

function buildCoderPrompt({ state, gateGroupNames, corrective, reason }) {
  const issue = state.issue;
  const lines = [
    `Bead: ${issue.id}`,
    `Title: ${issue.title}`,
    `Description: ${issue.description}`,
    `Design: ${issue.design}`,
    `Acceptance: ${issue.acceptance}`,
    `Dependencies: ${issue.dependencies.map((dependency) => `${dependency.id}:${dependency.status}`).join(", ") || "none"}`,
    `Owned paths: ${state.ownedPaths.join(", ")}`,
    `Prohibited actions: ${state.prohibitedActions.join(", ")}`,
    `Gate groups: ${gateGroupNames.length > 0 ? gateGroupNames.join(", ") : "none"}`,
    "Output schema: JSON object with required status, summary, ownedPaths, commandsAttempted, changedPaths, and optional gatesClaimed, artifacts.",
    "Worker constraints: use BEADS_DIR only for readonly context, do not write Beads, Git, remotes, or PRs.",
    "Do not read or modify files outside the assigned worktree."
  ];
  if (corrective) {
    lines.push(`Corrective context: ${sanitizePromptText(reason, { maxLength: 3000 })}`);
  }
  return lines.join("\n");
}

function buildPlanReviewPrompt({ state, strongReview }) {
  const issue = state.issue;
  return [
    "Review only the sanitized Bead specification below.",
    `Spec hash: ${state.specHash}`,
    `Title: ${issue.title}`,
    `Description: ${issue.description}`,
    `Design: ${issue.design}`,
    `Acceptance: ${issue.acceptance}`,
    `Dependencies: ${issue.dependencies.map((dependency) => `${dependency.id}:${dependency.status}`).join(", ") || "none"}`,
    `Strong review required: ${strongReview ? "yes" : "no"}`,
    "Do not inspect repository files, implementation diffs, or external systems.",
    "Return JSON with status, summary, findings, commandsAttempted."
  ].join("\n");
}

function buildReviewPrompt({ state, artifactPath, reviewVendor, strongReview }) {
  return [
    `Review bead ${state.beadId}.`,
    `Artifact path: ${artifactPath}`,
    `Scope lock: review only the supplied artifact and test evidence. Do not run git, gh, network, or wander the repository.`,
    `Review vendor: ${reviewVendor}`,
    `Strong review required: ${strongReview ? "yes" : "no"}`,
    "Return JSON with status, summary, findings, commandsAttempted."
  ].join("\n");
}

async function validateVerifiedDiff({ adapter, config, state, projectRoot, beadId }) {
  const beforeSnapshot = await snapshotForState(state);
  const verifiedArtifactPath = path.join(projectStateRoot(projectRoot), "artifacts", beadId, "delivery-verified-diff.md");
  const diffArtifact = await buildScopeLockedDiffArtifact({
    worktreePath: state.worktreePath,
    beforeSnapshot,
    filePath: verifiedArtifactPath
  });
  const verifiedArtifactHash = sha256Text(await readFile(verifiedArtifactPath, "utf8"));
  if (verifiedArtifactHash !== state.reviewState?.reviewedArtifactHash) {
    throw new Error("current diff no longer matches the reviewed artifact");
  }
  assertOwnedPaths({
    ownedPaths: state.ownedPaths,
    changedPaths: diffArtifact.changedPaths,
    protectedPaths: adapter.controlPlane.protectedPaths,
    mode: config.pluginMaintenanceMode ? "plugin-maintenance" : "default"
  });
  const privacyFindings = await scanPrivacyInPaths(state.worktreePath, diffArtifact.changedPaths);
  if (privacyFindings.length > 0) {
    throw new Error("privacy or attribution findings detected before delivery");
  }
  return {
    artifactPath: verifiedArtifactPath,
    artifactHash: verifiedArtifactHash,
    changedPaths: diffArtifact.changedPaths
  };
}

function validateTeamFacingDelivery({ state, prBody, config }) {
  const providerNames = Object.keys(config.providers || {});
  assertTeamFacingTextClean(state.branch, { beadId: state.beadId, providerNames });
  assertTeamFacingTextClean(state.neutralNames.commitMessage, { beadId: state.beadId, providerNames });
  assertTeamFacingTextClean(state.neutralNames.prTitle, { beadId: state.beadId, providerNames });
  assertTeamFacingTextClean(prBody, { beadId: state.beadId, providerNames });
}

async function runGateGroupsChecked({ adapter, config, projectRoot, worktreePath, gateName, gateNames, env }) {
  const groups = adapter.gates.groups;
  const selectedNames = gateNames || (gateName ? [gateName] : Object.keys(groups));
  const results = [];
  for (const name of selectedNames) {
    const gates = groups[name];
    if (!gates) {
      throw new Error(`unknown gate group: ${name}`);
    }
    for (const gate of gates) {
      if (gate.humanOnly) {
        results.push({ group: name, gate: gate.name, status: "human-action-required", reason: gate.reason });
        continue;
      }
      const [command, ...args] = gate.command;
      const run = await runCommandChecked({
        config,
        projectRoot,
        cwd: gate.cwd ? path.join(worktreePath, gate.cwd) : worktreePath,
        worktreePath,
        command,
        args,
        env,
        timeoutMs: 30 * 60 * 1000,
        label: `gate:${name}:${gate.name}`
      });
      results.push({
        group: name,
        gate: gate.name,
        status: run.code === 0 ? "passed" : "failed",
        code: run.code,
        stdout: run.stdout,
        stderr: run.stderr
      });
    }
  }
  return results;
}

async function runPlanReview({ projectRoot, beadId, state, config, adapter, env }) {
  const policy = computeReviewVendorPolicy(adapter, state.riskClass);
  const { candidates, hasQuorum } = candidateReviewProviders({
    config,
    providerNames: uniqueProviders(config.reviewProviders || []),
    requiredVendors: policy.reviewVendors,
    strongOnly: policy.strongReviewersOnly
  });
  if (!hasQuorum) {
    return result("provider-quorum-unavailable", "plan", {
      reason: `need ${policy.reviewVendors} distinct review vendors, found ${candidates.length}`
    });
  }
  const findings = [];
  const specCwd = await mkdtemp(path.join(os.tmpdir(), `agent-relay-plan-${beadId}-`));
  for (const { providerName, providerConfig, vendor } of candidates) {
    const providerEnv = await buildProviderExecutionEnv({
      providerConfig,
      beadId,
      providerName,
      mode: "read-only"
    });
    const promptPath = await writeProviderPrompt({
      projectRoot,
      beadId,
      fileName: `plan-review-${providerName}.txt`,
      contents: buildPlanReviewPrompt({
        state,
        strongReview: policy.strongReviewersOnly
      })
    });
    const run = await runCommandChecked({
      config,
      projectRoot,
      cwd: specCwd,
      command: providerConfig.command,
      args: [...(providerConfig.args || []), promptPath],
      env: providerEnv,
      timeoutMs: providerConfig.timeoutMs || adapter.providers.capabilities[providerName]?.timeoutMs || 1800000,
      label: `plan-review:${providerName}`
    });
    if (run.code !== 0) {
      continue;
    }
    const report = validateReviewReport(parseWorkerReport(run.stdout));
    assertCommandsAllowed(report.commandsAttempted);
    const outputPath = path.join(projectStateRoot(projectRoot), "artifacts", beadId, `plan-review-${providerName}.json`);
    await writeJson(outputPath, report);
    findings.push({ provider: providerName, vendor, report, outputPath });
    if (findings.length >= policy.reviewVendors) {
      break;
    }
  }
  if (findings.length < policy.reviewVendors) {
    return result("provider-quorum-unavailable", "plan", {
      reason: `successful plan-review vendor quorum absent; need ${policy.reviewVendors}, found ${findings.length}`
    });
  }
  const findingsResolved = findings.every((item) => item.report.status === "success" && item.report.findings.length === 0);
  const nextState = await writeState(projectRoot, beadId, {
    ...state,
    planReview: {
      completed: true,
      findingsResolved,
      reviewers: findings.map((item) => item.provider),
      findings: findings.map((item) => ({
        provider: item.provider,
        status: item.report.status,
        summary: item.report.summary,
        findings: item.report.findings
      })),
      approvalRequired: state.planReview?.approvalRequired ?? (config.planApprovalRiskClasses || []).includes(state.riskClass),
      approvalSpecHash: state.specHash
    }
  });
  appendBeadComment({
    env,
    beadId,
    comment: {
      kind: "agent-relay-plan-review",
      at: nowIso(),
      specHash: state.specHash,
      findingsResolved,
      reviewers: findings.map((item) => ({
        provider: item.provider,
        status: item.report.status,
        summary: item.report.summary
      }))
    }
  });
  await appendCheckpoint({
    projectRoot,
    beadId,
    env,
    label: "plan-review-finished",
    statePatch: {
      planReview: nextState.planReview
    },
    details: {
      reviewers: findings.map((item) => ({ provider: item.provider, status: item.report.status })),
      findingsResolved
    }
  });
  if (!findingsResolved) {
    const paused = await writeState(projectRoot, beadId, {
      ...nextState,
      phase: "awaiting-human"
    });
    return result("human-action-required", "plan", {
      state: paused,
      reason: "plan review requires human follow-up",
      findings
    });
  }
  return ok("plan", { state: nextState, findings, policy });
}

async function ensurePlanReady({ projectRoot, beadId, state, config, adapter, env, action }) {
  let nextState = state;
  const policy = computeReviewVendorPolicy(adapter, state.riskClass);
  const reviewComplete =
    nextState.planReview?.completed &&
    nextState.planReview?.approvalSpecHash === nextState.specHash &&
    (nextState.planReview?.reviewers?.length || 0) >= policy.reviewVendors;
  if (!reviewComplete) {
    const planReviewResult = await runPlanReview({ projectRoot, beadId, state: nextState, config, adapter, env });
    if (!planReviewResult.ok) {
      return planReviewResult.action === "plan"
        ? { ...planReviewResult, action }
        : planReviewResult;
    }
    nextState = planReviewResult.state;
  }
  if (!nextState.planReview.findingsResolved) {
    return result("human-action-required", action, {
      state: nextState,
      reason: "plan review requires human follow-up",
      findings: nextState.planReview.findings || []
    });
  }
  if (nextState.planReview.approvalRequired) {
    const beads = verifyBeadsStore({ adapter, env, beadId, claim: false, alreadyClaimed: true });
    const approval = approvalForSpecHash(beads.comments, nextState.specHash);
    if (!approval || approval.approved !== true) {
      const paused = await writeState(projectRoot, beadId, {
        ...nextState,
        phase: "awaiting-plan-approval"
      });
      await appendCheckpoint({
        projectRoot,
        beadId,
        env,
        label: "plan-approval-required",
        statePatch: {
          phase: "awaiting-plan-approval",
          planReview: paused.planReview
        },
        details: {
          specHash: nextState.specHash
        }
      });
      const approvalExists = beads.approvals?.length > 0;
      return result("human-action-required", action, {
        state: paused,
        reason: approvalExists
          ? `plan approval comment is missing a matching specHash for ${nextState.specHash}`
          : `add {"kind":"agent-relay-plan-approval","specHash":"${nextState.specHash}","approved":true} to approve this plan`
      });
    }
    if (nextState.phase === "awaiting-plan-approval") {
      nextState = await writeState(projectRoot, beadId, {
        ...nextState,
        phase: "planning"
      });
    }
  }
  return ok(action, { state: nextState });
}

async function executeCoder({ projectRoot, beadId, state, config, adapter, env }) {
  const order = adapter.providers.orchestratorOrder;
  const limit = config.correctionLimit ?? 2;
  const gateGroupNames = gateGroupsForPhase(adapter, "implementation", state.riskClass);
  const baselineSnapshot = await snapshotForState(state);
  const preferredIndex = state.pendingCorrection && state.lastCoder
    ? Math.max(order.indexOf(state.lastCoder), 0)
    : (state.providerCursor?.coderIndex || 0);
  for (let providerIndex = preferredIndex; providerIndex < order.length; providerIndex += 1) {
    const providerName = order[providerIndex];
    const providerConfig = providerCommandFromConfig(config, providerName);
    if (!providerConfig) {
      continue;
    }
    let serviceRetries = 0;
    let correctionRounds = state.correctionRounds || 0;
    let correctiveReason = state.pendingCorrection || "";
    while (true) {
      const providerEnv = await buildProviderExecutionEnv({
        providerConfig,
        beadId,
        providerName,
        mode: "implementation"
      });
      const promptPath = await writeProviderPrompt({
        projectRoot,
        beadId,
        fileName: `implement-${providerName}-${correctionRounds}.txt`,
        contents: buildCoderPrompt({
          state,
          gateGroupNames,
          corrective: Boolean(correctiveReason),
          reason: correctiveReason
        })
      });
      const run = await runCommandChecked({
        config,
        projectRoot,
        cwd: state.worktreePath,
        worktreePath: state.worktreePath,
        command: providerConfig.command,
        args: [...(providerConfig.args || []), promptPath],
        env: providerEnv,
        timeoutMs: providerConfig.timeoutMs || adapter.providers.capabilities[providerName]?.timeoutMs || 1800000,
        label: `coder:${providerName}`
      });
      let report;
      if (run.code !== 0) {
        const classification = classifyProviderFailure(run);
        const diffArtifact = await buildScopeLockedDiffArtifact({
          worktreePath: state.worktreePath,
          beforeSnapshot: baselineSnapshot,
          filePath: path.join(projectStateRoot(projectRoot), "artifacts", beadId, `implement-${providerName}-failure.md`)
        });
        await appendCheckpoint({
          projectRoot,
          beadId,
          env,
          label: "coder-provider-failure",
          statePatch: {
            providerCursor: { ...(state.providerCursor || {}), coderIndex: providerIndex },
            dirtyWorktree: diffArtifact.changedPaths.length > 0
          },
          details: { provider: providerName, classification, changedPaths: diffArtifact.changedPaths }
        });
        if (classification === "handoff-immediate") {
          break;
        }
        if (classification === "handoff-after-retry") {
          if (serviceRetries < 1) {
            serviceRetries += 1;
            continue;
          }
          break;
        }
        if (classification === "checkpoint-and-handoff") {
          break;
        }
        if (correctionRounds >= limit) {
          return result("human-action-required", "run", {
            reason: "coder correction limit exceeded",
            provider: providerName
          });
        }
        correctionRounds += 1;
        correctiveReason = run.stderr || run.stdout || "implementation command failed";
        continue;
      }
      try {
        report = validateWorkerReport(parseWorkerReport(run.stdout));
      } catch (error) {
        const diffArtifact = await buildScopeLockedDiffArtifact({
          worktreePath: state.worktreePath,
          beforeSnapshot: baselineSnapshot,
          filePath: path.join(projectStateRoot(projectRoot), "artifacts", beadId, `implement-${providerName}-malformed.md`)
        });
        await appendCheckpoint({
          projectRoot,
          beadId,
          env,
          label: "coder-malformed-report",
          statePatch: {
            providerCursor: { ...(state.providerCursor || {}), coderIndex: providerIndex },
            dirtyWorktree: diffArtifact.changedPaths.length > 0
          },
          details: { provider: providerName, error: error.message, changedPaths: diffArtifact.changedPaths }
        });
        break;
      }
      assertCommandsAllowed(report.commandsAttempted);
      if (report.status === "provider-failure") {
        const classification = classifyProviderFailure({
          stdout: "",
          stderr: report.summary,
          signal: null,
          timedOut: false
        });
        const diffArtifact = await buildScopeLockedDiffArtifact({
          worktreePath: state.worktreePath,
          beforeSnapshot: baselineSnapshot,
          filePath: path.join(projectStateRoot(projectRoot), "artifacts", beadId, `implement-${providerName}-provider-failure.md`)
        });
        await appendCheckpoint({
          projectRoot,
          beadId,
          env,
          label: "coder-provider-failure",
          statePatch: {
            providerCursor: { ...(state.providerCursor || {}), coderIndex: providerIndex },
            dirtyWorktree: diffArtifact.changedPaths.length > 0
          },
          details: {
            provider: providerName,
            classification,
            changedPaths: diffArtifact.changedPaths,
            summary: report.summary
          }
        });
        if (classification === "handoff-after-retry" && serviceRetries < 1) {
          serviceRetries += 1;
          continue;
        }
        break;
      }
      const diffArtifact = await buildScopeLockedDiffArtifact({
        worktreePath: state.worktreePath,
        beforeSnapshot: baselineSnapshot,
        filePath: path.join(projectStateRoot(projectRoot), "artifacts", beadId, `implement-${providerName}-diff.md`)
      });
      assertOwnedPaths({
        ownedPaths: state.ownedPaths,
        changedPaths: diffArtifact.changedPaths,
        protectedPaths: adapter.controlPlane.protectedPaths,
        mode: config.pluginMaintenanceMode ? "plugin-maintenance" : "default"
      });
      const privacyFindings = await scanPrivacyInPaths(state.worktreePath, diffArtifact.changedPaths);
      if (privacyFindings.length > 0) {
        return result("human-action-required", "run", {
          reason: "privacy or attribution findings detected",
          findings: privacyFindings
        });
      }
      if (report.status === "human-action-required") {
        return result("human-action-required", "run", {
          reason: report.summary,
          provider: providerName
        });
      }
      if (report.status === "needs-fix") {
        if (correctionRounds >= limit) {
          return result("human-action-required", "run", {
            reason: "coder correction limit exceeded",
            provider: providerName
          });
        }
        correctionRounds += 1;
        correctiveReason = report.summary;
        continue;
      }
      const gateResults = await runGateGroupsChecked({
        adapter,
        config,
        projectRoot,
        worktreePath: state.worktreePath,
        gateNames: gateGroupNames,
        env
      });
      const humanActionGates = gateResults.filter((gate) => gate.status === "human-action-required");
      if (humanActionGates.length > 0) {
        return result("human-action-required", "run", {
          reason: "implementation requires human-only gates",
          gateResults
        });
      }
      const failedGates = gateResults.filter((gate) => gate.status === "failed");
      if (failedGates.length > 0) {
        if (correctionRounds >= limit) {
          return result("human-action-required", "run", {
            reason: "gate correction limit exceeded",
            failedGates
          });
        }
        correctionRounds += 1;
        correctiveReason = `Gate failures:\n${failedGates.map((gate) => `${gate.group}/${gate.gate}: ${gate.stderr || gate.stdout}`).join("\n")}`;
        await appendCheckpoint({
          projectRoot,
          beadId,
          env,
          label: "gate-failure",
          statePatch: {
            correctionRounds
          },
          details: { provider: providerName, failedGates }
        });
        continue;
      }
      const nextState = await writeState(projectRoot, beadId, {
        ...state,
        phase: "reviewing",
        lastCoder: providerName,
        correctionRounds,
        pendingCorrection: null,
        latestChangedPaths: diffArtifact.changedPaths,
        latestDiffArtifact: path.join(projectStateRoot(projectRoot), "artifacts", beadId, `implement-${providerName}-diff.md`),
        latestSnapshotPath: path.join(projectStateRoot(projectRoot), "artifacts", beadId, `post-implement-snapshot.json`),
        gateResults,
        dirtyWorktree: diffArtifact.changedPaths.length > 0,
        providerCursor: {
          ...(state.providerCursor || {}),
          coderIndex: providerIndex
        }
      });
      await writeJson(nextState.latestSnapshotPath, diffArtifact.afterSnapshot);
      await appendCheckpoint({
        projectRoot,
        beadId,
        env,
        label: "implementation-finished",
        statePatch: {
          phase: nextState.phase,
          lastCoder: providerName,
          latestChangedPaths: diffArtifact.changedPaths,
          latestDiffArtifact: nextState.latestDiffArtifact,
          latestSnapshotPath: nextState.latestSnapshotPath,
          gateResults,
          dirtyWorktree: nextState.dirtyWorktree,
          correctionRounds,
          pendingCorrection: null
        }
      });
      return ok("run", { state: nextState, report, gateResults });
    }
  }
  return result("provider-quorum-unavailable", "run", {
    reason: "no provider could complete implementation"
  });
}

async function runReviewer({ projectRoot, beadId, state, config, adapter, env }) {
  const policy = computeReviewVendorPolicy(adapter, state.riskClass);
  const coderConfig = providerCommandFromConfig(config, state.lastCoder);
  const coderVendor = coderConfig ? providerVendor(state.lastCoder, coderConfig) : null;
  const { candidates, hasQuorum } = candidateReviewProviders({
    config,
    providerNames: uniqueProviders(config.reviewProviders || []),
    requiredVendors: policy.reviewVendors,
    excludedVendor: coderVendor,
    strongOnly: policy.strongReviewersOnly
  });
  if (!hasQuorum) {
    return result("provider-quorum-unavailable", "review", {
      reason: `need ${policy.reviewVendors} distinct review vendors, found ${candidates.length}`
    });
  }
  const findings = [];
  for (const { providerName, providerConfig, vendor } of candidates) {
    const providerEnv = await buildProviderExecutionEnv({
      providerConfig,
      beadId,
      providerName,
      mode: "read-only"
    });
    const beforeSnapshot = await captureSnapshot(state.worktreePath, { ignorePrefixes: [".git", ".agents/agent-relay"] });
    const promptPath = await writeProviderPrompt({
      projectRoot,
      beadId,
      fileName: `review-${providerName}.txt`,
      contents: buildReviewPrompt({
        state,
        artifactPath: state.latestDiffArtifact,
        reviewVendor: providerName,
        strongReview: policy.strongReviewersOnly
      })
    });
    const run = await runCommandChecked({
      config,
      projectRoot,
      cwd: state.worktreePath,
      worktreePath: state.worktreePath,
      command: providerConfig.command,
      args: [...(providerConfig.args || []), promptPath],
      env: providerEnv,
      timeoutMs: providerConfig.timeoutMs || adapter.providers.capabilities[providerName]?.timeoutMs || 1800000,
      label: `reviewer:${providerName}`
    });
    if (run.code !== 0) {
      continue;
    }
    const afterSnapshot = await captureSnapshot(state.worktreePath, { ignorePrefixes: [".git", ".agents/agent-relay"] });
    if (sha256Json(beforeSnapshot) !== sha256Json(afterSnapshot)) {
      throw new Error(`reviewer mutated worktree contents during ${providerName}`);
    }
    const report = validateReviewReport(parseWorkerReport(run.stdout));
    assertCommandsAllowed(report.commandsAttempted);
    const outputPath = path.join(projectStateRoot(projectRoot), "artifacts", beadId, `review-${providerName}.json`);
    await writeJson(outputPath, report);
    findings.push({ provider: providerName, vendor, report, outputPath });
    if (findings.length >= policy.reviewVendors) {
      break;
    }
  }
  if (findings.length < policy.reviewVendors) {
    return result("provider-quorum-unavailable", "review", {
      reason: `successful review vendor quorum absent; need ${policy.reviewVendors}, found ${findings.length}`
    });
  }
  return ok("review", { findings, policy });
}

function renderPullRequestBody({ state, reviewFindings }) {
  const gateLines = (state.gateResults || [])
    .map((gate) => `- ${gate.group}/${gate.gate}: ${gate.status}`)
    .join("\n");
  const reviewClean = reviewFindings.every((finding) => finding.report.status === "success");
  const reviewSummary = reviewClean
    ? "- Independent review quorum passed"
    : "- Independent review quorum requested follow-up";
  return [
    "## What",
    `- Deliver ${state.issue.title}`,
    "",
    "## Changes",
    `- Review-clean worktree for ${state.neutralNames.branch}`,
    "",
    "## Evidence",
    gateLines || "- No gates recorded",
    reviewSummary,
    "",
    "## Out of scope",
    "- Merge",
    "",
    "## Review focus",
    "- Confirm the attached gate and review evidence"
  ].join("\n");
}

async function deliverReviewedWork({ projectRoot, beadId, state, config, adapter, env, reviewFindings }) {
  if (!config.delivery?.enabled) {
    return result("human-action-required", "review", {
      reason: "delivery is not configured"
    });
  }
  if (!config.delivery.identity?.name || !config.delivery.identity?.email) {
    return result("human-action-required", "review", {
      reason: "delivery identity is not configured"
    });
  }
  if (!config.github?.command) {
    return result("human-action-required", "review", {
      reason: "GitHub CLI command is not configured"
    });
  }
  const changedPaths = state.latestChangedPaths || [];
  if (changedPaths.length === 0) {
    return result("human-action-required", "review", {
      reason: "no changed paths are available for explicit staging"
    });
  }
  const deliveryGateNames = gateGroupsForPhase(adapter, "delivery", state.riskClass);
  const gateResults = await runGateGroupsChecked({
    adapter,
    config,
    projectRoot,
    worktreePath: state.worktreePath,
    gateNames: deliveryGateNames,
    env
  });
  if (gateResults.some((gate) => gate.status === "failed")) {
    return result("human-action-required", "review", {
      reason: "delivery gates failed",
      gateResults
    });
  }
  if (gateResults.some((gate) => gate.status === "human-action-required")) {
    return result("human-action-required", "review", {
      reason: "delivery requires human-only gates",
      gateResults
    });
  }
  const verifiedDiff = await validateVerifiedDiff({
    adapter,
    config,
    state,
    projectRoot,
    beadId
  });
  const prBody = renderPullRequestBody({ state, reviewFindings });
  validateTeamFacingDelivery({ state, prBody, config });
  const stageRun = await runCommandChecked({
    config,
    projectRoot,
    cwd: state.worktreePath,
    worktreePath: state.worktreePath,
    command: config.git.command,
    args: ["add", "--", ...verifiedDiff.changedPaths],
    env: config.git.env || {},
    timeoutMs: 30000,
    label: "git-add-explicit"
  });
  if (stageRun.code !== 0) {
    throw new Error(`git add failed: ${stageRun.stderr || stageRun.stdout}`);
  }
  const commitRun = await runCommandChecked({
    config,
    projectRoot,
    cwd: state.worktreePath,
    worktreePath: state.worktreePath,
    command: config.git.command,
    args: [
      "-c",
      `user.name=${config.delivery.identity.name}`,
      "-c",
      `user.email=${config.delivery.identity.email}`,
      "commit",
      "-m",
      state.neutralNames.commitMessage
    ],
    env: config.git.env || {},
    timeoutMs: 30000,
    label: "git-commit",
    allowHeadChange: true
  });
  if (commitRun.code !== 0) {
    throw new Error(`git commit failed: ${commitRun.stderr || commitRun.stdout}`);
  }
  const pushRun = await runCommandChecked({
    config,
    projectRoot,
    cwd: state.worktreePath,
    worktreePath: state.worktreePath,
    command: config.git.command,
    args: ["push", "--set-upstream", "origin", state.branch],
    env: config.git.env || {},
    timeoutMs: 120000,
    label: "git-push"
  });
  if (pushRun.code !== 0) {
    throw new Error(`git push failed: ${pushRun.stderr || pushRun.stdout}`);
  }
  const prBodyPath = path.join(projectStateRoot(projectRoot), "artifacts", beadId, "pull-request-body.md");
  await writeFile(prBodyPath, `${prBody}\n`, "utf8");
  const prRun = await runCommandChecked({
    config,
    projectRoot,
    cwd: state.worktreePath,
    worktreePath: state.worktreePath,
    command: config.github.command,
    args: [
      "pr",
      "create",
      "--title",
      state.neutralNames.prTitle,
      "--body-file",
      prBodyPath,
      "--base",
      state.baseBranch,
      "--head",
      state.branch
    ],
    env: config.github.env || {},
    timeoutMs: 120000,
    label: "gh-pr-create"
  });
  if (prRun.code !== 0) {
    throw new Error(`gh pr create failed: ${prRun.stderr || prRun.stdout}`);
  }
  const worktreeStatus = await getGitStatus(config, state.worktreePath);
  const prUrl = parsePrUrl(prRun.stdout || "");
  const nextState = await writeState(projectRoot, beadId, {
    ...state,
    phase: "complete",
    dirtyWorktree: worktreeStatus.length > 0,
    gateResults,
    latestChangedPaths: verifiedDiff.changedPaths,
    latestDiffArtifact: verifiedDiff.artifactPath,
    reviewState: {
      ...(state.reviewState || {}),
      reviewedArtifactHash: verifiedDiff.artifactHash
    },
    delivery: {
      prUrl
    }
  });
  await appendCheckpoint({
    projectRoot,
    beadId,
    env,
    label: "delivery-finished",
    statePatch: {
      phase: "complete",
      dirtyWorktree: nextState.dirtyWorktree,
      gateResults,
      delivery: nextState.delivery
    },
    details: { prUrl }
  });
  return ok("review", { state: nextState, prUrl });
}

export async function doctor({ projectRoot, adapterName = "example-app" }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config, excludePath } = await ensureProjectState(projectRoot, adapterName);
  const roles = await syncRoleBundles({ check: true });
  const adapters = await syncAdapters({ check: true });
  const problems = [];
  for (const requiredFile of adapter.guidance.requiredFiles) {
    if (!(await pathExists(path.join(projectRoot, requiredFile)))) {
      problems.push(`missing required guidance file: ${requiredFile}`);
    }
  }
  return problems.length > 0
    ? result("project-misconfigured", "doctor", { problems, adapter: adapter.name, config, excludePath, roles: roles.length, adapters: adapters.length })
    : ok("doctor", { adapter: adapter.name, config, excludePath, roles: roles.length, adapters: adapters.length });
}

export async function setup({ projectRoot, adapterName }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config, excludePath } = await ensureProjectState(projectRoot, adapterName);
  const syncedRoles = await syncProjectRoles(projectRoot);
  return ok("setup", {
    adapter: adapter.name,
    config,
    configPath: projectConfigPath(projectRoot),
    excludePath,
    syncedRoles,
    localStateRoot: projectStateRoot(projectRoot)
  });
}

async function planUnlocked({ projectRoot, adapterName, beadId, env = process.env }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config } = await ensureProjectState(projectRoot, adapterName);
  const state = await ensurePlannedState({ projectRoot, adapterName, beadId, adapter, env, config });
  return ensurePlanReady({ projectRoot, beadId, state, config, adapter, env, action: "plan" });
}

export async function status({ projectRoot, beadId }) {
  if (!beadId) {
    const stateDir = path.join(projectStateRoot(projectRoot), "state");
    if (!(await pathExists(stateDir))) {
      return ok("status", { runs: [] });
    }
    const files = (await readdir(stateDir)).filter((file) => file.endsWith(".json")).sort();
    const runs = [];
    for (const fileName of files) {
      runs.push(await readJson(path.join(stateDir, fileName)));
    }
    return ok("status", { runs });
  }
  const state = await readJson(runStatePath(projectRoot, beadId));
  const ledgerPath = runLedgerPath(projectRoot, beadId);
  const ledger = (await pathExists(ledgerPath))
    ? (await readFile(ledgerPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return ok("status", { state, ledger });
}

async function runUnlocked({ projectRoot, adapterName, beadId, env = process.env }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config } = await ensureProjectState(projectRoot, adapterName);
  let state = await loadOrRecoverState({ projectRoot, adapterName, beadId, adapter, env, config });
  const planReady = await ensurePlanReady({ projectRoot, beadId, state, config, adapter, env, action: "run" });
  if (!planReady.ok) {
    return planReady;
  }
  state = planReady.state;
  state = await createWorktreeIfMissing({ projectRoot, beadId, adapter, config, state, env });
  return executeCoder({ projectRoot, beadId, state, config, adapter, env });
}

async function reviewUnlocked({ projectRoot, adapterName, beadId, env = process.env }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config } = await ensureProjectState(projectRoot, adapterName);
  let state = await loadOrRecoverState({ projectRoot, adapterName, beadId, adapter, env, config });
  if (!state.latestDiffArtifact) {
    return result("human-action-required", "review", {
      reason: "implementation has not produced a diff artifact yet"
    });
  }
  const reviewResult = await runReviewer({ projectRoot, beadId, state, config, adapter, env });
  if (!reviewResult.ok) {
    return reviewResult;
  }
  const findings = reviewResult.findings;
  const reviewedArtifactHash = sha256Text(await readFile(state.latestDiffArtifact, "utf8"));
  await appendCheckpoint({
    projectRoot,
    beadId,
    env,
    label: "review-finished",
    statePatch: {
      phase: "delivering",
      reviewState: {
        requiredVendors: reviewResult.policy.reviewVendors,
        completedVendors: findings.map((item) => item.provider),
        findingsResolved: findings.every((item) => item.report.status === "success"),
        reviewedArtifactHash
      }
    },
    details: { findings: findings.map((item) => ({ provider: item.provider, status: item.report.status })) }
  });
  state = await writeState(projectRoot, beadId, {
    ...state,
    phase: "delivering",
    reviewState: {
      requiredVendors: reviewResult.policy.reviewVendors,
      completedVendors: findings.map((item) => item.provider),
      findingsResolved: findings.every((item) => item.report.status === "success"),
      reviewedArtifactHash
    }
  });
  const needsFix = findings.some((item) => item.report.status === "needs-fix" || item.report.findings.length > 0);
  if (needsFix) {
    if ((state.correctionRounds || 0) >= (config.correctionLimit ?? 2)) {
      return result("human-action-required", "review", {
        state,
        reason: "review correction limit exceeded",
        findings
      });
    }
    const correctiveState = await writeState(projectRoot, beadId, {
      ...state,
      phase: "implementing",
      correctionRounds: (state.correctionRounds || 0) + 1,
      pendingCorrection: buildCorrectionReason(findings),
      providerCursor: {
        ...(state.providerCursor || {}),
        coderIndex: Math.max(adapter.providers.orchestratorOrder.indexOf(state.lastCoder), 0)
      }
    });
    await appendCheckpoint({
      projectRoot,
      beadId,
      env,
      label: "review-requested-correction",
      statePatch: {
        phase: "implementing",
        correctionRounds: correctiveState.correctionRounds,
        pendingCorrection: correctiveState.pendingCorrection,
        providerCursor: correctiveState.providerCursor
      },
      details: { findings: findings.map((item) => ({ provider: item.provider, summary: item.report.summary })) }
    });
    const rerun = await runUnlocked({ projectRoot, adapterName, beadId, env });
    if (!rerun.ok) {
      return rerun;
    }
    return reviewUnlocked({ projectRoot, adapterName, beadId, env });
  }
  return deliverReviewedWork({ projectRoot, beadId, state, config, adapter, env, reviewFindings: findings });
}

export async function gates({ projectRoot, adapterName, beadId, gateName, env = process.env }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config } = await ensureProjectState(projectRoot, adapterName);
  const state = beadId
    ? await loadOrRecoverState({ projectRoot, adapterName, beadId, adapter, env, config })
    : { worktreePath: projectRoot };
  const results = await runGateGroupsChecked({
    adapter,
    config,
    projectRoot,
    worktreePath: state.worktreePath || projectRoot,
    gateName,
    env
  });
  return results.some((item) => item.status !== "passed")
    ? result("human-action-required", "gates", { results })
    : ok("gates", { results });
}

async function resumeUnlocked({ projectRoot, adapterName, beadId, env = process.env }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config } = await ensureProjectState(projectRoot, adapterName);
  let state = await loadOrRecoverState({ projectRoot, adapterName, beadId, adapter, env, config });
  const planReady = await ensurePlanReady({ projectRoot, beadId, state, config, adapter, env, action: "resume" });
  if (!planReady.ok) {
    return planReady;
  }
  state = planReady.state;
  if (state.phase === "reviewing" || state.phase === "delivering") {
    return reviewUnlocked({ projectRoot, adapterName, beadId, env });
  }
  return runUnlocked({ projectRoot, adapterName, beadId, env });
}

async function cleanupUnlocked({ projectRoot, adapterName = "example-app", beadId }) {
  const { config } = await ensureProjectState(projectRoot, adapterName);
  const state = await readJson(runStatePath(projectRoot, beadId));
  if (state.phase !== "complete") {
    return result("human-action-required", "cleanup", {
      reason: "cleanup is blocked until delivery is complete"
    });
  }
  if (!config.cleanup?.allowDestructive) {
    return result("human-action-required", "cleanup", {
      reason: "cleanup requires explicit destructive approval in config"
    });
  }
  if (state.dirtyWorktree) {
    return result("human-action-required", "cleanup", {
      reason: "dirty or partially committed worktrees are preserved for human review"
    });
  }
  if (state.worktreePath && await pathExists(state.worktreePath)) {
    await removeWorktree(config, projectRoot, state.worktreePath);
  }
  await removePath(path.join(projectStateRoot(projectRoot), "artifacts", beadId));
  return ok("cleanup", {
    removed: {
      worktreePath: state.worktreePath || null,
      artifacts: path.join(projectStateRoot(projectRoot), "artifacts", beadId)
    }
  });
}

export async function plan(args) {
  return withBeadLock({ projectRoot: args.projectRoot, beadId: args.beadId, action: "plan" }, () => planUnlocked(args));
}

export async function run(args) {
  return withBeadLock({ projectRoot: args.projectRoot, beadId: args.beadId, action: "run" }, () => runUnlocked(args));
}

export async function review(args) {
  return withBeadLock({ projectRoot: args.projectRoot, beadId: args.beadId, action: "review" }, () => reviewUnlocked(args));
}

export async function resume(args) {
  return withBeadLock({ projectRoot: args.projectRoot, beadId: args.beadId, action: "resume" }, () => resumeUnlocked(args));
}

export async function cleanup(args) {
  return withBeadLock({ projectRoot: args.projectRoot, beadId: args.beadId, action: "cleanup" }, () => cleanupUnlocked(args));
}
