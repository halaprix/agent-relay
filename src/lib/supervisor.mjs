import path from "node:path";
import { copyFile, lstat, readdir, readFile, realpath, writeFile, mkdtemp, rename } from "node:fs/promises";
import os from "node:os";
import { loadAdapter, syncAdapters } from "./adapter.mjs";
import { appendBeadComment, approvalForSpecHash, rebuildStateFromBeadComments, verifyBeadsStore } from "./beads.mjs";
import { ensureDir, pathExists, readJson, writeJson, appendJsonl, removePath, listFilesRecursive } from "./fs.mjs";
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

const SUPPORTED_PROVIDER_VENDORS = new Set(["anthropic", "openai", "google"]);
let bubblewrapSupportPromise;
let bubblewrapSupportOverride = null;
let testIsolationRunnerEnabled = false;

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
  if (typeof providerConfig?.vendor !== "string" || providerConfig.vendor.trim() === "") {
    return null;
  }
  const vendor = providerConfig.vendor.trim().toLowerCase();
  return SUPPORTED_PROVIDER_VENDORS.has(vendor) ? vendor : null;
}

function providerStrength(providerConfig) {
  if (typeof providerConfig?.strength !== "string" || providerConfig.strength.trim() === "") {
    return null;
  }
  return providerConfig.strength.trim();
}

function validateRuntimeProviderConfig(providerName, providerConfig, { requireReviewMetadata = false } = {}) {
  if (!providerConfig || typeof providerConfig !== "object") {
    throw new Error(`provider ${providerName} is misconfigured`);
  }
  if (typeof providerConfig.command !== "string" || providerConfig.command.trim() === "") {
    throw new Error(`provider ${providerName}.command must be a non-empty string`);
  }
  if (providerConfig.args !== undefined && (!Array.isArray(providerConfig.args) || providerConfig.args.some((arg) => typeof arg !== "string"))) {
    throw new Error(`provider ${providerName}.args must be a string array`);
  }
  if (providerConfig.env !== undefined && (providerConfig.env === null || typeof providerConfig.env !== "object" || Array.isArray(providerConfig.env))) {
    throw new Error(`provider ${providerName}.env must be an object`);
  }
  if (!providerVendor(providerName, providerConfig)) {
    throw new Error(`provider ${providerName}.vendor must be configured explicitly to one of ${[...SUPPORTED_PROVIDER_VENDORS].join(", ")}`);
  }
  if (providerConfig.runtime !== undefined) {
    if (providerConfig.runtime === null || typeof providerConfig.runtime !== "object" || Array.isArray(providerConfig.runtime)) {
      throw new Error(`provider ${providerName}.runtime must be an object`);
    }
    if (providerConfig.runtime.readOnlyMounts !== undefined) {
      if (!Array.isArray(providerConfig.runtime.readOnlyMounts) || providerConfig.runtime.readOnlyMounts.some((mountPath) => typeof mountPath !== "string" || !path.isAbsolute(mountPath))) {
        throw new Error(`provider ${providerName}.runtime.readOnlyMounts must be an array of absolute paths`);
      }
    }
  }
  if (requireReviewMetadata) {
    if (!providerStrength(providerConfig)) {
      throw new Error(`provider ${providerName}.strength must be configured explicitly for review`);
    }
  }
}

async function resolveCommandPath(command, pathValue = process.env.PATH || "") {
  if (path.isAbsolute(command)) {
    return realpath(command);
  }
  for (const segment of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(segment, command);
    if (await pathExists(candidate)) {
      return realpath(candidate);
    }
  }
  throw new Error(`unable to resolve command path for ${command}`);
}

async function resolvePathForMount(targetPath) {
  if (!(await pathExists(targetPath))) {
    throw new Error(`runtime mount path does not exist: ${targetPath}`);
  }
  return realpath(targetPath);
}

async function resolveGitProtectionRoots(repoRoot) {
  const roots = new Set();
  if (!repoRoot) {
    return roots;
  }
  const gitEntryPath = path.join(repoRoot, ".git");
  if (!(await pathExists(gitEntryPath))) {
    return roots;
  }
  const gitStats = await lstat(gitEntryPath);
  if (gitStats.isDirectory()) {
    roots.add(await realpath(gitEntryPath));
    return roots;
  }
  const gitFile = await readFile(gitEntryPath, "utf8");
  const match = gitFile.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match) {
    return roots;
  }
  const gitDir = path.resolve(repoRoot, match[1].trim());
  if (await pathExists(gitDir)) {
    roots.add(await realpath(gitDir));
    const commonDirPath = path.join(gitDir, "commondir");
    if (await pathExists(commonDirPath)) {
      const commonDir = path.resolve(gitDir, (await readFile(commonDirPath, "utf8")).trim());
      if (await pathExists(commonDir)) {
        roots.add(await realpath(commonDir));
      }
    }
  }
  return roots;
}

function parentDirectories(targetPath) {
  const dirs = [];
  let current = path.dirname(targetPath);
  while (current && current !== path.dirname(current)) {
    dirs.push(current);
    current = path.dirname(current);
  }
  if (current === "/") {
    dirs.push("/");
  }
  return [...new Set(dirs)].reverse();
}

function isUnderAnyRoot(targetPath, roots) {
  return roots.some((root) => isSameOrDescendantPath(targetPath, root));
}

function overlapsAnyProtectedRoot(targetPath, roots) {
  return roots.some((root) =>
    isSameOrDescendantPath(targetPath, root) ||
    isSameOrDescendantPath(root, targetPath)
  );
}

function isSameOrDescendantPath(targetPath, candidateRoot) {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(candidateRoot);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function protectedRuntimeRoots({ projectRoot, config, adapter, writableRoot }) {
  const roots = new Set();
  const candidates = [
    projectRoot,
    config.mainCheckoutRoot || projectRoot,
    writableRoot,
    adapter.beads.requiredDir,
    projectStateRoot(projectRoot)
  ];
  for (const baseRoot of [projectRoot, config.mainCheckoutRoot || projectRoot, writableRoot]) {
    for (const protectedPath of adapter.controlPlane.protectedPaths || []) {
      candidates.push(path.join(baseRoot, protectedPath));
    }
    for (const gitRoot of await resolveGitProtectionRoots(baseRoot)) {
      roots.add(gitRoot);
    }
  }
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (await pathExists(candidate)) {
      roots.add(await realpath(candidate));
    } else {
      roots.add(path.resolve(candidate));
    }
  }
  return [...roots];
}

async function writeExecutable(filePath, body) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, body, { encoding: "utf8", mode: 0o755 });
}

function providerRunsOnNode(providerConfig) {
  const command = providerConfig.command || "";
  return (
    command === process.execPath ||
    /\bnode(?:js)?$/.test(path.basename(command)) ||
    command.endsWith(".js") ||
    command.endsWith(".mjs") ||
    command.endsWith(".cjs")
  );
}

async function bubblewrapSupported() {
  if (typeof bubblewrapSupportOverride === "boolean") {
    return bubblewrapSupportOverride;
  }
  if (bubblewrapSupportPromise) {
    return bubblewrapSupportPromise;
  }
  bubblewrapSupportPromise = (async () => {
    if (!(await pathExists("/usr/bin/bwrap"))) {
      return false;
    }
    let resolvedProbeCommand = null;
    for (const candidate of ["/usr/bin/true", "/bin/true", "/usr/bin/env"]) {
      if (await pathExists(candidate)) {
        resolvedProbeCommand = candidate;
        break;
      }
    }
    if (!resolvedProbeCommand) {
      return false;
    }
    const probeDir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-bwrap-probe-"));
    const run = await runProviderCommand({
      providerName: "bubblewrap-probe",
      command: "/usr/bin/bwrap",
      args: [
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--share-net",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/bin",
        "/bin",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--ro-bind",
        "/etc",
        "/etc",
        "--dir",
        probeDir,
        "--chdir",
        probeDir,
        resolvedProbeCommand
      ],
      cwd: probeDir,
      env: {},
      timeoutMs: 2000,
      inheritEnv: false,
      captureViaEnv: false
    });
    return run.code === 0;
  })();
  return bubblewrapSupportPromise;
}

async function createTestIsolationHook({ bundleRoot, writableRoot, blockedCandidates }) {
  const hookPath = path.join(bundleRoot, "test-isolation-hook.cjs");
  const blockedPaths = [...blockedCandidates.keys()].sort();
  const blockedBasenames = [...new Set([...blockedCandidates.values(), "git", "gh", "bd"])].sort();
  const hookSource = `
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const cp = require("node:child_process");
const path = require("node:path");

if (!global.__agentRelayTestIsolationInstalled) {
  global.__agentRelayTestIsolationInstalled = true;
  const writableRoot = ${JSON.stringify(writableRoot)};
  const blockedPaths = new Set(${JSON.stringify(blockedPaths)});
  const blockedBasenames = new Set(${JSON.stringify(blockedBasenames)});
  const allowedExtraWrites = new Set(
    [process.env.AGENT_RELAY_STDOUT_FILE, process.env.AGENT_RELAY_STDERR_FILE]
      .filter(Boolean)
      .map((targetPath) => path.normalize(targetPath))
  );

  function resolvePath(targetPath) {
    try {
      return fs.realpathSync(targetPath);
    } catch {
      return path.resolve(targetPath);
    }
  }

  function resolveWriteTarget(targetPath) {
    return path.normalize(path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath));
  }

  function assertWritable(targetPath) {
    const resolved = resolveWriteTarget(targetPath);
    if (
      !allowedExtraWrites.has(resolved) &&
      resolved !== writableRoot &&
      !resolved.startsWith(writableRoot + path.sep)
    ) {
      throw new Error("agent-relay test isolation blocked write outside writable root: " + resolved);
    }
  }

  function patchFsWrite(object, method) {
    if (typeof object?.[method] !== "function") {
      return;
    }
    const original = object[method];
    object[method] = function patched(targetPath, ...args) {
      assertWritable(targetPath);
      return original.call(this, targetPath, ...args);
    };
  }

  function patchOpen(object, method) {
    if (typeof object?.[method] !== "function") {
      return;
    }
    const original = object[method];
    object[method] = function patched(targetPath, flags, ...args) {
      const mode = typeof flags === "string" ? flags : "";
      if (/[wa+]/.test(mode)) {
        assertWritable(targetPath);
      }
      return original.call(this, targetPath, flags, ...args);
    };
  }

  function patchRename(object, method) {
    if (typeof object?.[method] !== "function") {
      return;
    }
    const original = object[method];
    object[method] = function patched(sourcePath, destinationPath, ...args) {
      assertWritable(sourcePath);
      assertWritable(destinationPath);
      return original.call(this, sourcePath, destinationPath, ...args);
    };
  }

  function patchSpawnLike(method) {
    if (typeof cp[method] !== "function") {
      return;
    }
    const original = cp[method];
    cp[method] = function patched(command, ...args) {
      const commandText = typeof command === "string" ? command : "";
      const basename = path.basename(commandText || "");
      const resolved = commandText ? resolvePath(commandText) : "";
      if (
        blockedBasenames.has(commandText) ||
        blockedBasenames.has(basename) ||
        blockedPaths.has(commandText) ||
        blockedPaths.has(resolved)
      ) {
        throw new Error("agent-relay test isolation blocked executable: " + commandText);
      }
      return original.call(this, command, ...args);
    };
  }

  patchFsWrite(fs, "writeFile");
  patchFsWrite(fs, "appendFile");
  patchFsWrite(fs, "writeFileSync");
  patchFsWrite(fs, "appendFileSync");
  patchFsWrite(fsp, "writeFile");
  patchFsWrite(fsp, "appendFile");
  patchOpen(fs, "open");
  patchOpen(fs, "openSync");
  patchOpen(fsp, "open");
  patchRename(fs, "rename");
  patchRename(fs, "renameSync");
  patchRename(fsp, "rename");
  patchSpawnLike("spawn");
  patchSpawnLike("execFile");
  patchSpawnLike("execFileSync");
  patchSpawnLike("exec");
  patchSpawnLike("execSync");
  patchSpawnLike("fork");
}
`;
  await writeFile(hookPath, hookSource, "utf8");
  return hookPath;
}

function allowTestIsolationRunner(providerConfig) {
  return Boolean(testIsolationRunnerEnabled && providerConfig?.env?.FAKE_PROVIDER_STORE);
}

async function mirrorProviderEnvFiles(env, writableRoot, providerName) {
  const mirrored = { ...env };
  const syncBack = [];
  for (const key of ["FAKE_PROVIDER_STORE", "FAKE_GIT_STORE", "FAKE_GH_STORE", "FAKE_GATE_STORE"]) {
    if (!env[key]) {
      continue;
    }
    const targetPath = env[key];
    const mirrorPath = path.join(writableRoot, "mirrors", providerName, path.basename(targetPath));
    await ensureDir(path.dirname(mirrorPath));
    if (await pathExists(targetPath)) {
      await copyFile(targetPath, mirrorPath);
    } else {
      await writeFile(mirrorPath, "", "utf8");
    }
    mirrored[key] = mirrorPath;
    syncBack.push({ mirrorPath, targetPath });
  }
  return {
    mirrored,
    async flush() {
      for (const file of syncBack) {
        if (await pathExists(file.mirrorPath)) {
          await copyFile(file.mirrorPath, file.targetPath);
        }
      }
    }
  };
}

async function createProviderBundle({ beadId, providerName, promptContents, copiedArtifacts = [] }) {
  const bundleRoot = await mkdtemp(path.join(os.tmpdir(), `agent-relay-provider-${beadId}-${providerName}-`));
  const promptPath = path.join(bundleRoot, "prompt.txt");
  await writeFile(promptPath, `${promptContents}\n`, "utf8");
  const copied = [];
  const files = new Map([["prompt.txt", promptPath]]);
  for (const artifact of copiedArtifacts) {
    const destination = path.join(bundleRoot, artifact.fileName);
    await copyFile(artifact.sourcePath, destination);
    copied.push(destination);
    files.set(artifact.fileName, destination);
  }
  return {
    bundleRoot,
    promptPath,
    copiedArtifacts: copied,
    files
  };
}

async function prepareIsolatedProviderRun({
  projectRoot,
  adapter,
  config,
  supervisorEnv = process.env,
  providerConfig,
  beadId,
  providerName,
  cwd,
  writableRoot,
  promptContents,
  promptBuilder = null,
  copiedArtifacts = []
}) {
  validateRuntimeProviderConfig(providerName, providerConfig);
  const bundle = await createProviderBundle({ beadId, providerName, promptContents: "", copiedArtifacts });
  const finalPromptContents = typeof promptBuilder === "function"
    ? await promptBuilder(bundle)
    : promptContents;
  await writeFile(bundle.promptPath, `${finalPromptContents}\n`, "utf8");
  const sandboxRoot = path.join(writableRoot, ".agent-relay-sandbox", `${providerName}-${Date.now()}-${process.pid}`);
  await ensureDir(path.join(sandboxRoot, "home"));
  const { mirrored, flush } = await mirrorProviderEnvFiles(providerConfig.env || {}, sandboxRoot, providerName);
  const pathValue = mirrored.PATH || process.env.PATH || "";
  const supervisorPathValue = supervisorEnv.PATH || process.env.PATH || "";
  const originalCommand = providerConfig.command;
  const absoluteCommand = await resolveCommandPath(originalCommand, pathValue);
  const commandArgs = providerConfig.args || [];
  const resolvedCommand = originalCommand.endsWith(".mjs") || originalCommand.endsWith(".js") ? process.execPath : absoluteCommand;
  const resolvedArgs =
    resolvedCommand === process.execPath && absoluteCommand !== process.execPath
      ? [absoluteCommand, ...commandArgs, bundle.promptPath]
      : [...commandArgs, bundle.promptPath];
  const mounts = new Map();
  for (const systemDir of ["/usr", "/bin", "/lib", "/lib64", "/etc"]) {
    if (await pathExists(systemDir)) {
      mounts.set(systemDir, { source: systemDir, mode: "ro" });
    }
  }
  mounts.set(bundle.bundleRoot, { source: bundle.bundleRoot, mode: "ro" });
  mounts.set(writableRoot, { source: writableRoot, mode: "rw" });

  let resolvedBeadsDir = null;
  let resolvedBdCommand = null;
  if (await pathExists(adapter.beads.requiredDir)) {
    resolvedBeadsDir = await resolvePathForMount(adapter.beads.requiredDir);
  }
  const bdCandidate = supervisorEnv.AGENT_RELAY_BD_BIN || "bd";
  try {
    resolvedBdCommand = await resolveCommandPath(bdCandidate, supervisorPathValue);
  } catch {
    resolvedBdCommand = null;
  }
  if (resolvedBeadsDir) {
    mounts.set(resolvedBeadsDir, { source: resolvedBeadsDir, mode: "ro" });
  }
  if (resolvedBdCommand && !isUnderAnyRoot(resolvedBdCommand, [...mounts.keys()])) {
    mounts.set(resolvedBdCommand, { source: resolvedBdCommand, mode: "ro" });
  }

  const runtimeRoots = await protectedRuntimeRoots({
    projectRoot,
    config,
    adapter,
    writableRoot
  });
  for (const mountPath of providerConfig.runtime?.readOnlyMounts || []) {
    const resolvedMountPath = await resolvePathForMount(mountPath);
    if (overlapsAnyProtectedRoot(resolvedMountPath, runtimeRoots)) {
      throw new Error(`provider ${providerName}.runtime.readOnlyMounts cannot overlap protected project, worktree, Beads, or control-plane paths: ${mountPath}`);
    }
    mounts.set(resolvedMountPath, { source: resolvedMountPath, mode: "ro" });
  }

  const providerFiles = [resolvedCommand, ...resolvedArgs.filter((arg) => path.isAbsolute(arg))];
  for (const providerFile of providerFiles) {
    if (isUnderAnyRoot(providerFile, [...mounts.keys()])) {
      continue;
    }
    mounts.set(providerFile, { source: providerFile, mode: "ro" });
  }

  const blockedRoot = path.join(bundle.bundleRoot, "blocked");
  const denyBody = (name) => `#!/usr/bin/env sh\necho "${name} is blocked by agent-relay supervision" >&2\nexit 1\n`;
  const blockedCandidates = new Map();
  for (const candidate of [config.git?.command, config.github?.command, "git", "gh"].filter(Boolean)) {
    try {
      const resolved = await resolveCommandPath(candidate, pathValue);
      blockedCandidates.set(resolved, path.basename(resolved));
    } catch {
      continue;
    }
  }
  for (const [resolvedPath, name] of blockedCandidates) {
    const denyPath = path.join(blockedRoot, name);
    await writeExecutable(denyPath, denyBody(name));
    mounts.set(resolvedPath, { source: denyPath, mode: "ro" });
  }

  const env = {
    HOME: path.join(sandboxRoot, "home"),
    LANG: process.env.LANG || "C.UTF-8",
    PATH: mirrored.PATH || process.env.PATH || "/usr/bin:/bin",
    ...mirrored
  };

  if (!(await bubblewrapSupported())) {
    delete env.BEADS_DIR;
    delete env.AGENT_RELAY_BD_BIN;
    delete env.AGENT_RELAY_BEADS_READONLY;
    delete env.AGENT_RELAY_STDOUT_FILE;
    delete env.AGENT_RELAY_STDERR_FILE;
    if (!allowTestIsolationRunner(providerConfig) || !providerRunsOnNode(providerConfig)) {
      throw new Error(`provider containment is unavailable for ${providerName}`);
    }
    const hookPath = await createTestIsolationHook({
      bundleRoot: bundle.bundleRoot,
      writableRoot,
      blockedCandidates
    });
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require ${hookPath}`].filter(Boolean).join(" ").trim();
    return {
      command: resolvedCommand,
      args:
        resolvedCommand === process.execPath || /\bnode(?:js)?$/.test(path.basename(resolvedCommand))
          ? ["--require", hookPath, ...resolvedArgs]
          : resolvedArgs,
      env,
      captureViaEnv: true,
      bundleRoot: bundle.bundleRoot,
      promptPath: bundle.promptPath,
      copiedArtifactPaths: bundle.copiedArtifacts,
      async finalize() {
        await flush();
      }
    };
  }

  if (resolvedBeadsDir) {
    env.BEADS_DIR = resolvedBeadsDir;
    env.AGENT_RELAY_BEADS_READONLY = "1";
  }
  if (resolvedBdCommand) {
    env.AGENT_RELAY_BD_BIN = resolvedBdCommand;
  }
  delete env.AGENT_RELAY_STDOUT_FILE;
  delete env.AGENT_RELAY_STDERR_FILE;

  const dirTargets = new Set(["/proc", "/dev", ...parentDirectories(cwd), ...parentDirectories(bundle.bundleRoot)]);
  for (const target of mounts.keys()) {
    for (const dir of parentDirectories(target)) {
      dirTargets.add(dir);
    }
  }
  const bwrapArgs = ["--die-with-parent", "--new-session", "--unshare-all", "--share-net", "--proc", "/proc", "--dev", "/dev"];
  for (const dir of [...dirTargets].sort((left, right) => left.length - right.length)) {
    if (dir !== "/") {
      bwrapArgs.push("--dir", dir);
    }
  }
  for (const [target, mount] of mounts.entries()) {
    bwrapArgs.push(mount.mode === "rw" ? "--bind" : "--ro-bind", mount.source, target);
  }
  bwrapArgs.push("--chdir", cwd, resolvedCommand, ...resolvedArgs);
  return {
    command: "/usr/bin/bwrap",
    args: bwrapArgs,
    cwd,
    env,
    bundleRoot: bundle.bundleRoot,
    promptPath: bundle.promptPath,
    copiedArtifactPaths: bundle.copiedArtifacts,
    async finalize() {
      await flush();
    }
  };
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
  const snapshot = await captureSnapshot(worktreePath, { ignorePrefixes: [".git", ".agents/agent-relay", ".agent-relay-sandbox"] });
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
    "Worker constraints: when BEADS_DIR is available it is mounted read-only; if you inspect Beads, use `bd --readonly ...`. Under fallback containment BEADS_DIR may be unavailable. Do not write Beads, Git, remotes, or PRs.",
    "Do not read or modify files outside the assigned worktree."
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
          reason: correctiveReason
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
    const beforeSnapshot = await captureSnapshot(state.worktreePath, { ignorePrefixes: [".git", ".agents/agent-relay", ".agent-relay-sandbox"] });
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
    const afterSnapshot = await captureSnapshot(state.worktreePath, { ignorePrefixes: [".git", ".agents/agent-relay", ".agent-relay-sandbox"] });
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

export async function __prepareIsolatedProviderRunForTests(args) {
  return prepareIsolatedProviderRun(args);
}

export function __setTestIsolationRunnerForTests(enabled) {
  testIsolationRunnerEnabled = Boolean(enabled);
}

export function __resetTestIsolationRunnerForTests() {
  testIsolationRunnerEnabled = false;
}

export function __setBubblewrapSupportForTests(supported) {
  bubblewrapSupportOverride = supported;
  bubblewrapSupportPromise = null;
}

export function __resetBubblewrapSupportForTests() {
  bubblewrapSupportOverride = null;
  bubblewrapSupportPromise = null;
}
