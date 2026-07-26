// Worker containment: sandbox construction and mounts.
import path from "node:path";
import os from "node:os";
import { copyFile, lstat, readFile, realpath, writeFile, mkdtemp } from "node:fs/promises";
import { ensureDir, pathExists, removePath, withTempDir } from "./fs.mjs";
import { projectResourcesRoot, projectStateRoot } from "./paths.mjs";
import { resolveBeadsDir, resolveResourcesRootName } from "./adapter.mjs";
import { runProviderCommand, validateRuntimeProviderConfig } from "./provider.mjs";

let bubblewrapSupportPromise;
let bubblewrapSupportOverride = null;
let testIsolationRunnerEnabled = false;

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
  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

async function protectedRuntimeRoots({ projectRoot, config, adapter, writableRoot }) {
  const roots = new Set();
  const candidates = [
    projectRoot,
    config.mainCheckoutRoot || projectRoot,
    writableRoot,
    resolveBeadsDir(adapter, projectRoot),
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
    return withTempDir("agent-relay-bwrap-probe-", async (probeDir) => {
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
    });
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

export async function prepareIsolatedProviderRun({
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
  let sandboxRoot = null;
  try {
    return await buildIsolatedRun();
  } catch (error) {
    await removePath(bundle.bundleRoot).catch(() => {});
    if (sandboxRoot) {
      await removePath(sandboxRoot).catch(() => {});
    }
    throw error;
  }

  async function buildIsolatedRun() {
  const finalPromptContents = typeof promptBuilder === "function"
    ? await promptBuilder(bundle)
    : promptContents;
  await writeFile(bundle.promptPath, `${finalPromptContents}\n`, "utf8");
  sandboxRoot = path.join(writableRoot, ".agent-relay-sandbox", `${providerName}-${Date.now()}-${process.pid}`);
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
  const projectBeadsDir = resolveBeadsDir(adapter, projectRoot);
  if (await pathExists(projectBeadsDir)) {
    resolvedBeadsDir = await resolvePathForMount(projectBeadsDir);
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

  let resolvedResourcesRoot = null;
  const resourcesRootPath = projectResourcesRoot(projectRoot, resolveResourcesRootName(adapter));
  if (await pathExists(resourcesRootPath)) {
    const candidate = await resolvePathForMount(resourcesRootPath);
    const writableRootReal = (await pathExists(writableRoot)) ? await realpath(writableRoot) : path.resolve(writableRoot);
    if (!overlapsAnyProtectedRoot(candidate, [writableRootReal])) {
      resolvedResourcesRoot = candidate;
      mounts.set(candidate, { source: candidate, mode: "ro" });
    }
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
  if (resolvedResourcesRoot) {
    env.AGENT_RELAY_RESOURCES_DIR = resolvedResourcesRoot;
  } else {
    delete env.AGENT_RELAY_RESOURCES_DIR;
  }

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
        await removePath(bundle.bundleRoot);
        await removePath(sandboxRoot);
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
      await removePath(bundle.bundleRoot);
      await removePath(sandboxRoot);
    }
  };
  }
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
