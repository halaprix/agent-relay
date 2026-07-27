import path from "node:path";
import { readdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import {
  beadsExcludeMarker,
  beadsStoreIsTracked,
  loadAdapter,
  resolveBeadsDir,
  resolveResourcesRootName,
  syncAdapters
} from "./adapter.mjs";
import {
  appendBeadComment,
  approvalForSpecHash,
  epicIdFor,
  exportBeadRecords,
  listBeadChildren,
  rebuildStateFromBeadComments,
  verifyBeadsStore
} from "./beads.mjs";
import { ensureDir, pathExists, readJson, writeJson, writeJsonAtomic, appendJsonl, removePath, listFilesRecursive } from "./fs.mjs";
import {
  buildStagedDiffArtifact,
  buildScopeLockedDiffArtifact,
  captureSnapshot,
  createDetachedWorktree,
  getGitBranch,
  getGitHead,
  getGitRemotes,
  getGitStatus,
  removeWorktree,
  resolveBaseSha,
  runGitText,
} from "./git.mjs";
import { assertCommandsAllowed, assertOwnedPaths, scanPrivacyInPaths } from "./guardrails.mjs";
import { sha256Json, sha256Text } from "./hash.mjs";
import { acquireLock } from "./lock.mjs";
import { ok, result } from "./output.mjs";
import {
  projectConfigPath,
  projectResourcesRoot,
  projectStateRoot,
  runLedgerPath,
  runStatePath
} from "./paths.mjs";
import { RESOURCES_DIR_NAME, SNAPSHOT_IGNORE_PREFIXES } from "./constants.mjs";
import { prepareIsolatedProviderRun } from "./containment.mjs";
import { classifyProviderFailure, parseWorkerReport, runProviderCommand, providerCommandFromConfig, providerVendor, providerStrength, validateRuntimeProviderConfig } from "./provider.mjs";
import { assertTeamFacingTextClean, sanitizeIssueForPrompt, sanitizePromptText, sanitizeTeamFacingText, slugifyTitle } from "./sanitize.mjs";
import { syncRoleBundles } from "./roles.mjs";
import { buildBeadGraph } from "./bead-graph.mjs";
import { renderBeadGraphHtml } from "./bead-graph-html.mjs";
import {
  agentInstructionExcludeMarkers,
  agentInstructionStatus,
  scaffoldAgentInstructions
} from "./agent-instructions.mjs";
import { PROVIDERS } from "./providers/index.mjs";
import { validateReviewReport, validateWorkerReport } from "./validate.mjs";

function nowIso() {
  return new Date().toISOString();
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

function agentRelayMetadata(bead) {
  const candidates = [
    bead?.metadata?.agentRelay,
    bead?.metadata?.agent_relay,
    bead?.customFields?.agentRelay,
    bead?.custom_fields?.agentRelay
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (typeof candidate === "string") {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        continue;
      }
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate;
    }
  }
  return {};
}

function resolveBeadPolicy(bead, config) {
  const metadata = agentRelayMetadata(bead);
  const riskClass = metadata.riskClass || bead.riskClass || "normal-code";
  const ownedPaths = Array.isArray(metadata.ownedPaths) && metadata.ownedPaths.length > 0
    ? metadata.ownedPaths
    : (Array.isArray(bead.ownedPaths) && bead.ownedPaths.length > 0 ? bead.ownedPaths : ["."]);
  const gateGroups = Array.isArray(metadata.gateGroups) && metadata.gateGroups.length > 0
    ? metadata.gateGroups
    : (Array.isArray(bead.gateGroups) ? bead.gateGroups : []);
  const approvalRequired = typeof metadata.approvalRequired === "boolean"
    ? metadata.approvalRequired
    : (config.planApprovalRiskClasses || []).includes(riskClass);
  return {
    riskClass,
    ownedPaths,
    gateGroups,
    approvalRequired
  };
}

function computeSpecHash(bead, policy) {
  return sha256Json({
    description: bead.description || "",
    design: bead.design || "",
    acceptance: bead.acceptance_criteria || bead.acceptance || "",
    dependencies: bead.dependencies || [],
    riskClass: policy.riskClass,
    ownedPaths: policy.ownedPaths,
    gateGroups: policy.gateGroups,
    approvalRequired: policy.approvalRequired
  });
}

function defaultPlanReview(approvalRequired, specHash) {
  return {
    completed: false,
    findingsResolved: false,
    reviewers: [],
    findings: [],
    approvalRequired,
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
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider.name, null])),
    reviewProviders: PROVIDERS.map((provider) => provider.name),
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

async function ensureGitExclude(projectRoot, markers) {
  const excludePath = path.join(projectRoot, ".git", "info", "exclude");
  if (!(await pathExists(path.dirname(excludePath)))) {
    return null;
  }
  const current = (await readFile(excludePath, "utf8").catch(() => "")).split("\n");
  const missing = markers.filter((marker) => !current.includes(marker));
  if (missing.length > 0) {
    const next = `${[...current.filter(Boolean), ...missing].join("\n")}\n`;
    await writeFile(excludePath, next, "utf8");
  }
  return excludePath;
}

function renderResourcesReadme(resourcesRootName) {
  return [
    `# ${resourcesRootName}`,
    "",
    "Local, never-committed cache of external reference material for agents working in this project.",
    "",
    "Rules:",
    "",
    `- \`${resourcesRootName}/\` is ignored by Git. Nothing here is a deliverable and nothing here is reviewed.`,
    "- Agents read from it. Relay workers receive it read-only; the human or the supervisor writes it.",
    "- Store one topic per directory with a `SOURCE.md` recording the origin URL and the fetch date.",
    "- Project law (AGENTS.md, architecture docs, ADRs) always wins over anything cached here.",
    "- Treat every entry as a possibly stale snapshot; re-fetch instead of editing it in place.",
    ""
  ].join("\n");
}

async function ensureResourcesRoot(projectRoot, resourcesRootName) {
  const resourcesRoot = projectResourcesRoot(projectRoot, resourcesRootName);
  await ensureDir(resourcesRoot);
  const readmePath = path.join(resourcesRoot, "README.md");
  if (!(await pathExists(readmePath))) {
    await writeFile(readmePath, renderResourcesReadme(resourcesRootName), "utf8");
  }
  return resourcesRoot;
}

// An epic is scope, not a unit of work, and `bd ready` lists epics next to leaves. Refuse the
// container before a worktree, a lock, or a provider call exists.
function rejectContainerBead({ env, adapter, projectRoot, beadId, action }) {
  const children = listBeadChildren({ env, beadId, beadsDir: resolveBeadsDir(adapter, projectRoot) });
  if (!children || children.length === 0) {
    return null;
  }
  const claimable = children.filter((child) => child.status !== "closed").map((child) => child.id);
  const suffix = claimable.length > 0 ? `: ${claimable.join(", ")}` : " (every child is closed)";
  return result("project-misconfigured", action, {
    reason: `${beadId} is a container with ${children.length} child bead(s), not a unit of work. Claim a leaf beneath it${suffix}.`,
    beadId,
    children: children.map((child) => ({ id: child.id, title: child.title, status: child.status }))
  });
}

function withProjectBeadsDir(env, adapter, projectRoot) {
  const beadsDir = resolveBeadsDir(adapter, projectRoot);
  return { ...env, BEADS_DIR: beadsDir };
}

// Shared preamble for the four bead-scoped entrypoints (plan/run/review/resume): load the
// adapter, ensure project state, scope env to this project's beads dir, then refuse if beadId
// names a container rather than a leaf. `gates` (optional beadId) and `cleanupUnlocked`
// (different shape) do not go through here.
async function openBeadAction({ projectRoot, adapterName, beadId, env, action }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config } = await ensureProjectState(projectRoot, adapterName, adapter);
  env = withProjectBeadsDir(env, adapter, projectRoot);
  const rejection = rejectContainerBead({ env, adapter, projectRoot, beadId, action });
  return { adapter, config, env, rejection };
}

function inheritedBeadsDirIgnored(env, beadsDir) {
  return Boolean(env.BEADS_DIR) && path.resolve(env.BEADS_DIR) !== path.resolve(beadsDir);
}

async function ensureProjectState(projectRoot, adapterName, adapter = null) {
  const stateRoot = projectStateRoot(projectRoot);
  await ensureDir(path.join(stateRoot, "state"));
  await ensureDir(path.join(stateRoot, "artifacts"));
  await ensureDir(path.join(stateRoot, "worktrees"));
  const config = await readProjectConfig(projectRoot, adapterName);
  const resourcesRootName = resolveResourcesRootName(adapter);
  const resourcesRoot = await ensureResourcesRoot(projectRoot, resourcesRootName);
  const markers = [
    ".agents/agent-relay/",
    `${resourcesRootName}/`,
    beadsExcludeMarker(adapter),
    ...agentInstructionExcludeMarkers()
  ].filter(Boolean);
  const excludePath = await ensureGitExclude(projectRoot, markers);
  const beadsDir = adapter ? resolveBeadsDir(adapter, projectRoot) : null;
  return { config, excludePath, stateRoot, resourcesRoot, resourcesRootName, beadsDir };
}

async function syncProjectRoles(projectRoot) {
  const outputs = await syncRoleBundles();
  const syncedRoles = [];
  for (const provider of PROVIDERS) {
    const dir = path.join(projectRoot, ...provider.projectDir);
    if (!(await pathExists(path.dirname(dir)))) {
      continue;
    }
    await ensureDir(dir);
    for (const output of outputs) {
      const destination = path.join(dir, `${output.role}.${provider.extension}`);
      await writeFile(destination, output[provider.name], "utf8");
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

function candidateReviewProviders({ config, providerNames, requiredVendors, excludedVendor = null, strongOnly = false }) {
  const candidates = [];
  const seenVendors = new Set();
  for (const providerName of providerNames) {
    const providerConfig = providerCommandFromConfig(config, providerName);
    if (!providerConfig) {
      continue;
    }
    validateRuntimeProviderConfig(providerName, providerConfig, { requireReviewMetadata: true });
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
  allowBranchChange = false,
  inheritEnv = true,
  captureViaEnv = true,
  postRun = null
}) {
  const before = await captureControlPlaneSnapshot(config, projectRoot, worktreePath);
  const run = await runProviderCommand({
    providerName: label,
    command,
    args,
    cwd,
    env,
    timeoutMs,
    inheritEnv,
    captureViaEnv
  });
  if (postRun) {
    await postRun(run);
  }
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
    return routing.deliveryByRisk?.[riskClass] || routing.deliveryDefault || routing.deliveryFull || ["pre-push"];
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
  const policy = resolveBeadPolicy(bead, config);
  const specHash = computeSpecHash(bead, policy);
  const names = neutralNames(sanitizedIssue.title, specHash);
  return {
    beadId: bead.id,
    adapterName,
    projectRoot,
    phase: "planning",
    riskClass: policy.riskClass,
    issue: sanitizedIssue,
    specHash,
    ownedPaths: policy.ownedPaths,
    prohibitedActions: [
      "git mutation by worker",
      "beads write by worker",
      "remote mutation",
      "force push"
    ],
    gateGroups: policy.gateGroups,
    providerCursor: {
      coderIndex: 0,
      reviewProvidersTried: []
    },
    correctionRounds: 0,
    pendingCorrection: null,
    planReview: defaultPlanReview(policy.approvalRequired, specHash),
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

function mergeRecoveredState({ liveState, recovered, adapter }) {
  const hashesMatch = recovered.specHash === liveState.specHash;
  const preserved = {
    worktreePath: recovered.worktreePath || liveState.worktreePath,
    baseSha: recovered.baseSha || liveState.baseSha,
    baseBranch: recovered.baseBranch || liveState.baseBranch,
    branch: recovered.branch || liveState.branch,
    setupComplete: recovered.setupComplete || false,
    snapshotPath: recovered.snapshotPath || liveState.snapshotPath,
    latestSnapshotPath: recovered.latestSnapshotPath || liveState.latestSnapshotPath,
    latestDiffArtifact: recovered.latestDiffArtifact || liveState.latestDiffArtifact,
    latestChangedPaths: recovered.latestChangedPaths || liveState.latestChangedPaths,
    lastCoder: recovered.lastCoder || liveState.lastCoder,
    dirtyWorktree: recovered.dirtyWorktree || false,
    providerCursor: recovered.providerCursor || liveState.providerCursor,
    timestamps: recovered.timestamps || liveState.timestamps
  };
  if (!hashesMatch) {
    return {
      ...liveState,
      ...preserved,
      phase: "planning",
      correctionRounds: 0,
      pendingCorrection: null,
      gateResults: [],
      delivery: { prUrl: null },
      planReview: defaultPlanReview(liveState.planReview.approvalRequired, liveState.specHash),
      reviewState: {
        requiredVendors: computeReviewVendorPolicy(adapter, liveState.riskClass).reviewVendors,
        completedVendors: [],
        findingsResolved: false
      }
    };
  }
  return {
    ...liveState,
    ...preserved,
    phase: recovered.phase || liveState.phase,
    correctionRounds: recovered.correctionRounds || 0,
    pendingCorrection: recovered.pendingCorrection ?? null,
    gateResults: recovered.gateResults || liveState.gateResults,
    delivery: recovered.delivery || liveState.delivery,
    planReview: {
      ...(recovered.planReview || liveState.planReview),
      approvalRequired: liveState.planReview.approvalRequired,
      approvalSpecHash: liveState.specHash
    },
    reviewState: {
      ...(recovered.reviewState || liveState.reviewState),
      requiredVendors: computeReviewVendorPolicy(adapter, liveState.riskClass).reviewVendors
    }
  };
}

async function ensurePlannedState({ projectRoot, adapterName, beadId, adapter, env, config }) {
  const statePath = runStatePath(projectRoot, beadId);
  const hasLocalState = await pathExists(statePath);
  const beads = verifyBeadsStore({ adapter, env, beadId, beadsDir: resolveBeadsDir(adapter, projectRoot), claim: false, alreadyClaimed: true });
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
        planReview: defaultPlanReview(livePlan.planReview.approvalRequired, livePlan.specHash),
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
        ...(current.planReview || defaultPlanReview(livePlan.planReview.approvalRequired, livePlan.specHash)),
        approvalRequired: livePlan.planReview.approvalRequired,
        approvalSpecHash: livePlan.specHash
      }
    });
  }
  if (!beads.bead.claimed) {
    verifyBeadsStore({ adapter, env, beadId, beadsDir: resolveBeadsDir(adapter, projectRoot), claim: true, alreadyClaimed: false });
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
  const beads = verifyBeadsStore({ adapter, env, beadId, beadsDir: resolveBeadsDir(adapter, projectRoot), claim: false, alreadyClaimed: true });
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
  const state = await writeState(projectRoot, beadId, mergeRecoveredState({ liveState, recovered, adapter }));
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
  const snapshot = await captureSnapshot(worktreePath, { ignorePrefixes: SNAPSHOT_IGNORE_PREFIXES });
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
    owner: `${action}:${process.pid}`
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

function buildCoderPrompt({ state, gateGroupNames, corrective, reason, resourcesRootName = RESOURCES_DIR_NAME }) {
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
    "Worker constraints: when BEADS_DIR is available it is mounted read-only; if you inspect Beads, use `bd --readonly ...`. Under fallback containment BEADS_DIR may be unavailable. Do not write Beads, Git, remotes, or PRs.",
    `Reference cache: when AGENT_RELAY_RESOURCES_DIR is set it points at the project's read-only ${resourcesRootName}/ cache of external documentation. Read it for context only; it is never project law and never a deliverable.`,
    "Do not read or modify files outside the assigned worktree and that read-only reference cache."
  ];
  if (corrective) {
    lines.push(`Corrective context: ${sanitizePromptText(reason, { maxLength: 3000 })}`);
  }
  return lines.join("\n");
}

function buildPlanReviewPrompt({ specArtifactPath, strongReview, specHash }) {
  return [
    "Review only the sanitized specification artifact below.",
    `Spec hash: ${specHash}`,
    `Specification artifact: ${specArtifactPath}`,
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
  for (const { providerName, providerConfig, vendor } of candidates) {
    const specContents = [
      `Spec hash: ${state.specHash}`,
      `Title: ${state.issue.title}`,
      `Description: ${state.issue.description}`,
      `Design: ${state.issue.design}`,
      `Acceptance: ${state.issue.acceptance}`,
      `Dependencies: ${state.issue.dependencies.map((dependency) => `${dependency.id}:${dependency.status}`).join(", ") || "none"}`
    ].join("\n");
    const reviewRoot = await mkdtemp(path.join(os.tmpdir(), `agent-relay-plan-${beadId}-`));
    try {
      const isolated = await prepareIsolatedProviderRun({
        projectRoot,
        adapter,
        config,
        supervisorEnv: env,
        providerConfig,
        beadId,
        providerName,
        cwd: reviewRoot,
        writableRoot: reviewRoot,
        copiedArtifacts: [
          {
            sourcePath: await writeProviderPrompt({
              projectRoot,
              beadId,
              fileName: `plan-spec-${providerName}.txt`,
              contents: specContents
            }),
            fileName: "spec.txt"
          }
        ],
        promptBuilder: (bundle) =>
          buildPlanReviewPrompt({
            specArtifactPath: bundle.files.get("spec.txt"),
            strongReview: policy.strongReviewersOnly,
            specHash: state.specHash
          })
      });
      const run = await runCommandChecked({
        config,
        projectRoot,
        cwd: isolated.cwd,
        command: isolated.command,
        args: isolated.args,
        env: isolated.env,
        timeoutMs: providerConfig.timeoutMs || adapter.providers.capabilities[providerName]?.timeoutMs || 1800000,
        label: `plan-review:${providerName}`,
        inheritEnv: false,
        captureViaEnv: isolated.captureViaEnv ?? false,
        postRun: () => isolated.finalize()
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
    } finally {
      await removePath(reviewRoot);
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
    const beads = verifyBeadsStore({ adapter, env, beadId, beadsDir: resolveBeadsDir(adapter, projectRoot), claim: false, alreadyClaimed: true });
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
  const order = adapter.providers.providerOrder;
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
      const isolated = await prepareIsolatedProviderRun({
        projectRoot,
        adapter,
        config,
        supervisorEnv: env,
        providerConfig,
        beadId,
        providerName,
        cwd: state.worktreePath,
        writableRoot: state.worktreePath,
        promptContents: buildCoderPrompt({
          state,
          gateGroupNames,
          corrective: Boolean(correctiveReason),
          reason: correctiveReason,
          resourcesRootName: resolveResourcesRootName(adapter)
        })
      });
      const run = await runCommandChecked({
        config,
        projectRoot,
        cwd: state.worktreePath,
        worktreePath: state.worktreePath,
        command: isolated.command,
        args: isolated.args,
        env: isolated.env,
        timeoutMs: providerConfig.timeoutMs || adapter.providers.capabilities[providerName]?.timeoutMs || 1800000,
        label: `coder:${providerName}`,
        inheritEnv: false,
        captureViaEnv: isolated.captureViaEnv ?? false,
        postRun: () => isolated.finalize()
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
    const beforeSnapshot = await captureSnapshot(state.worktreePath, { ignorePrefixes: SNAPSHOT_IGNORE_PREFIXES });
    const isolated = await prepareIsolatedProviderRun({
      projectRoot,
      adapter,
      config,
      supervisorEnv: env,
      providerConfig,
      beadId,
      providerName,
      cwd: state.worktreePath,
      writableRoot: state.worktreePath,
      copiedArtifacts: [
        {
          sourcePath: state.latestDiffArtifact,
          fileName: "review-artifact.md"
        }
      ],
      promptBuilder: (bundle) =>
        buildReviewPrompt({
          state,
          artifactPath: bundle.files.get("review-artifact.md"),
          reviewVendor: providerName,
          strongReview: policy.strongReviewersOnly
        })
    });
    const run = await runCommandChecked({
      config,
      projectRoot,
      cwd: state.worktreePath,
      worktreePath: state.worktreePath,
      command: isolated.command,
      args: isolated.args,
      env: isolated.env,
      timeoutMs: providerConfig.timeoutMs || adapter.providers.capabilities[providerName]?.timeoutMs || 1800000,
      label: `reviewer:${providerName}`,
      inheritEnv: false,
      captureViaEnv: isolated.captureViaEnv ?? false,
      postRun: () => isolated.finalize()
    });
    if (run.code !== 0) {
      continue;
    }
    const afterSnapshot = await captureSnapshot(state.worktreePath, { ignorePrefixes: SNAPSHOT_IGNORE_PREFIXES });
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
  const stagedArtifactPath = path.join(projectStateRoot(projectRoot), "artifacts", beadId, "staged-index-diff.md");
  await buildStagedDiffArtifact({
    config,
    worktreePath: state.worktreePath,
    changedPaths: verifiedDiff.changedPaths,
    filePath: stagedArtifactPath
  });
  const stagedArtifactHash = sha256Text(await readFile(stagedArtifactPath, "utf8"));
  if (stagedArtifactHash !== state.reviewState?.reviewedArtifactHash) {
    throw new Error("staged index no longer matches the reviewed artifact");
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

export async function doctor({ projectRoot, adapterName = "example-app", env = process.env }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config, excludePath, resourcesRoot, beadsDir } = await ensureProjectState(projectRoot, adapterName, adapter);
  const roles = await syncRoleBundles({ check: true });
  const adapters = await syncAdapters({ check: true });
  const problems = [];
  for (const requiredFile of adapter.guidance.requiredFiles) {
    if (!(await pathExists(path.join(projectRoot, requiredFile)))) {
      problems.push(`missing required guidance file: ${requiredFile}`);
    }
  }
  const beadsStorePresent = await pathExists(beadsDir);
  if (!beadsStorePresent) {
    problems.push(`missing beads store at ${beadsDir}: run \`bd init --quiet\` in the project root`);
  }
  const details = {
    adapter: adapter.name,
    config,
    excludePath,
    resourcesRoot,
    resourcesIgnored: await resourcesRootIsIgnored(projectRoot, excludePath, resolveResourcesRootName(adapter)),
    beadsDir,
    beadsStorePresent,
    beadsTracked: beadsStoreIsTracked(adapter),
    inheritedBeadsDirIgnored: inheritedBeadsDirIgnored(env, beadsDir),
    roles: roles.length,
    adapters: adapters.length,
    agentInstructions: await agentInstructionStatus(projectRoot)
  };
  return problems.length > 0
    ? result("project-misconfigured", "doctor", { problems, ...details })
    : ok("doctor", details);
}

async function resourcesRootIsIgnored(projectRoot, excludePath, resourcesRootName) {
  const marker = `${resourcesRootName}/`;
  const sources = [excludePath, path.join(projectRoot, ".gitignore")].filter(Boolean);
  for (const source of sources) {
    const lines = (await readFile(source, "utf8").catch(() => "")).split("\n").map((line) => line.trim());
    if (lines.includes(marker) || lines.includes(resourcesRootName)) {
      return true;
    }
  }
  return false;
}

export async function setup({ projectRoot, adapterName }) {
  const { adapter } = await loadAdapter(adapterName);
  const { config, excludePath, resourcesRoot, beadsDir } = await ensureProjectState(projectRoot, adapterName, adapter);
  const syncedRoles = await syncProjectRoles(projectRoot);
  const agentInstructions = await scaffoldAgentInstructions(projectRoot);
  return ok("setup", {
    adapter: adapter.name,
    config,
    configPath: projectConfigPath(projectRoot),
    excludePath,
    resourcesRoot,
    beadsDir,
    beadsTracked: beadsStoreIsTracked(adapter),
    beadsStorePresent: await pathExists(beadsDir),
    syncedRoles,
    agentInstructions,
    localStateRoot: projectStateRoot(projectRoot)
  });
}

async function planUnlocked({ projectRoot, adapterName, beadId, env = process.env }) {
  const { adapter, config, env: scopedEnv, rejection } = await openBeadAction({ projectRoot, adapterName, beadId, env, action: "plan" });
  if (rejection) {
    return rejection;
  }
  env = scopedEnv;
  const state = await ensurePlannedState({ projectRoot, adapterName, beadId, adapter, env, config });
  return ensurePlanReady({ projectRoot, beadId, state, config, adapter, env, action: "plan" });
}

// Renders the dependency graph from `bd export` output. The export is read from
// stdout and never written to disk: an `.beads/issues.jsonl` file carries
// `created_by` identities and is neither gitignored nor covered by the privacy
// scanner, so keeping it in memory removes the hazard rather than managing it.
export async function graph({ projectRoot, adapterName, beadId = null, outPath = null, env = process.env }) {
  const { adapter } = await loadAdapter(adapterName);
  const beadsDir = resolveBeadsDir(adapter, projectRoot);
  const records = exportBeadRecords({ env, beadsDir });
  const model = buildBeadGraph(records, { rootId: beadId });
  const html = renderBeadGraphHtml(model, {
    title: beadId ? `${beadId} — bead graph` : "Bead graph",
    generatedFor: path.basename(projectRoot)
  });
  const destination = path.resolve(projectRoot, outPath || path.join(".agents", "agent-relay", "artifacts", beadId ? `graph-${beadId}.html` : "graph.html"));
  await ensureDir(path.dirname(destination));
  await writeFile(destination, html, "utf8");
  return ok("graph", {
    beadId,
    outPath: destination,
    beads: model.nodes.size,
    edges: model.edges.length,
    layers: model.layers.map((layer) => layer.length),
    counts: model.counts,
    cycleEdges: model.cycleEdges
  });
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
    // Grouping is presentation, so the dotted id is the right signal here — unlike the
    // container check, which reads the dependency graph because correctness depends on it.
    const byEpic = new Map();
    for (const run of runs) {
      const epic = epicIdFor(run.beadId || "");
      if (!byEpic.has(epic)) {
        byEpic.set(epic, []);
      }
      byEpic.get(epic).push(run.beadId || "");
    }
    const groups = [...byEpic.entries()]
      .map(([epic, beadIds]) => ({ epic, beadIds }))
      .sort((left, right) => left.epic.localeCompare(right.epic));
    return ok("status", { runs, groups });
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
  const { adapter, config, env: scopedEnv, rejection } = await openBeadAction({ projectRoot, adapterName, beadId, env, action: "run" });
  if (rejection) {
    return rejection;
  }
  env = scopedEnv;
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
  const { adapter, config, env: scopedEnv, rejection } = await openBeadAction({ projectRoot, adapterName, beadId, env, action: "review" });
  if (rejection) {
    return rejection;
  }
  env = scopedEnv;
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
        coderIndex: Math.max(adapter.providers.providerOrder.indexOf(state.lastCoder), 0)
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
  const { config } = await ensureProjectState(projectRoot, adapterName, adapter);
  env = withProjectBeadsDir(env, adapter, projectRoot);
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
  const { adapter, config, env: scopedEnv, rejection } = await openBeadAction({ projectRoot, adapterName, beadId, env, action: "resume" });
  if (rejection) {
    return rejection;
  }
  env = scopedEnv;
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

async function cleanupUnlocked({ projectRoot, adapterName, beadId }) {
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

export { __prepareIsolatedProviderRunForTests, __setTestIsolationRunnerForTests, __resetTestIsolationRunnerForTests, __setBubblewrapSupportForTests, __resetBubblewrapSupportForTests } from "./containment.mjs";

export const __candidateReviewProvidersForTests = candidateReviewProviders;
