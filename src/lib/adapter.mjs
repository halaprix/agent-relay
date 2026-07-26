import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { RESOURCES_DIR_NAME } from "./constants.mjs";
import { readJson, writeJson } from "./fs.mjs";
import { repoPath } from "./paths.mjs";
import { assertString, assertStringArray, requireKeys } from "./schema.mjs";

export async function loadAdapter(adapterName) {
  const adapterPath = repoPath("adapters", `${adapterName}.json`);
  const adapter = await readJson(adapterPath);
  validateAdapter(adapter);
  return { adapter, adapterPath };
}

function assertRelativeResourcesRoot(resourcesRoot) {
  if (path.isAbsolute(resourcesRoot) || resourcesRoot.split(/[\\/]/).includes("..")) {
    throw new Error("adapter.guidance.resourcesRoot must be a relative path inside the project");
  }
}

export function resolveResourcesRootName(adapter) {
  const configured = adapter?.guidance?.resourcesRoot;
  if (typeof configured !== "string" || configured.trim() === "") {
    return RESOURCES_DIR_NAME;
  }
  assertRelativeResourcesRoot(configured);
  return configured;
}

export function resolveBeadsDir(adapter, projectRoot) {
  const requiredDir = adapter?.beads?.requiredDir;
  assertString(requiredDir, "adapter.beads.requiredDir");
  if (path.isAbsolute(requiredDir)) {
    return path.normalize(requiredDir);
  }
  if (!projectRoot) {
    throw new Error("projectRoot is required to resolve a project-relative beads store");
  }
  return path.resolve(projectRoot, requiredDir);
}

export function beadsStoreIsTracked(adapter) {
  return adapter?.beads?.tracked === true;
}

export function beadsExcludeMarker(adapter) {
  const requiredDir = adapter?.beads?.requiredDir;
  if (typeof requiredDir !== "string" || requiredDir === "") {
    return null;
  }
  if (path.isAbsolute(requiredDir) || beadsStoreIsTracked(adapter)) {
    return null;
  }
  return `${requiredDir.replace(/\/+$/, "")}/`;
}

export function validateAdapter(adapter) {
  requireKeys("adapter", adapter, [
    "name",
    "version",
    "repository",
    "beads",
    "guidance",
    "gates",
    "controlPlane",
    "providers",
    "riskClasses",
    "humanOnlyActions"
  ]);
  assertString(adapter.name, "adapter.name");
  if (!Number.isInteger(adapter.version) || adapter.version < 1) {
    throw new Error("adapter.version must be an integer >= 1");
  }
  requireKeys("adapter.repository", adapter.repository, ["kind", "baseBranch", "worktreeSetupCommand"]);
  if (adapter.repository.kind !== "git") {
    throw new Error("adapter.repository.kind must be git");
  }
  assertString(adapter.repository.baseBranch, "adapter.repository.baseBranch");
  assertStringArray(adapter.repository.worktreeSetupCommand, "adapter.repository.worktreeSetupCommand");
  requireKeys("adapter.beads", adapter.beads, ["requiredDir", "memoryKey"]);
  assertString(adapter.beads.requiredDir, "adapter.beads.requiredDir");
  assertString(adapter.beads.memoryKey, "adapter.beads.memoryKey");
  if (!path.isAbsolute(adapter.beads.requiredDir) && adapter.beads.requiredDir.split(/[\\/]/).includes("..")) {
    throw new Error("adapter.beads.requiredDir must stay inside the project when it is relative");
  }
  if (adapter.beads.tracked !== undefined && typeof adapter.beads.tracked !== "boolean") {
    throw new Error("adapter.beads.tracked must be boolean");
  }
  requireKeys("adapter.guidance", adapter.guidance, [
    "requiredFiles",
    "protectedLawFiles",
    "architectureRoots",
    "prTemplate",
    "noAttribution"
  ]);
  assertStringArray(adapter.guidance.requiredFiles, "adapter.guidance.requiredFiles");
  assertStringArray(adapter.guidance.protectedLawFiles, "adapter.guidance.protectedLawFiles");
  assertStringArray(adapter.guidance.architectureRoots, "adapter.guidance.architectureRoots");
  assertString(adapter.guidance.prTemplate, "adapter.guidance.prTemplate");
  if (typeof adapter.guidance.noAttribution !== "boolean") {
    throw new Error("adapter.guidance.noAttribution must be boolean");
  }
  if (adapter.guidance.resourcesRoot !== undefined) {
    assertString(adapter.guidance.resourcesRoot, "adapter.guidance.resourcesRoot");
    assertRelativeResourcesRoot(adapter.guidance.resourcesRoot);
  }
  requireKeys("adapter.gates", adapter.gates, ["routing", "groups"]);
  requireKeys("adapter.gates.routing", adapter.gates.routing, [
    "planReviewDefault",
    "implementationDefault",
    "implementationByRisk",
    "deliveryDefault",
    "deliveryByRisk",
    "deliveryFull",
    "humanApproval"
  ]);
  assertStringArray(adapter.gates.routing.planReviewDefault, "adapter.gates.routing.planReviewDefault");
  assertStringArray(adapter.gates.routing.implementationDefault, "adapter.gates.routing.implementationDefault");
  assertStringArray(adapter.gates.routing.deliveryDefault, "adapter.gates.routing.deliveryDefault");
  assertStringArray(adapter.gates.routing.deliveryFull, "adapter.gates.routing.deliveryFull");
  assertStringArray(adapter.gates.routing.humanApproval, "adapter.gates.routing.humanApproval");
  if (adapter.gates.routing.implementationByRisk === null || typeof adapter.gates.routing.implementationByRisk !== "object") {
    throw new Error("adapter.gates.routing.implementationByRisk must be an object");
  }
  if (adapter.gates.routing.deliveryByRisk === null || typeof adapter.gates.routing.deliveryByRisk !== "object") {
    throw new Error("adapter.gates.routing.deliveryByRisk must be an object");
  }
  if (adapter.gates.groups === null || typeof adapter.gates.groups !== "object") {
    throw new Error("adapter.gates.groups must be an object");
  }
  const gateGroupNames = new Set(Object.keys(adapter.gates.groups));
  for (const [groupName, gates] of Object.entries(adapter.gates.groups)) {
    assertString(groupName, "gate group name");
    if (!Array.isArray(gates) || gates.length === 0) {
      throw new Error(`gate group ${groupName} must contain gates`);
    }
    for (const gate of gates) {
      requireKeys(`gate ${groupName}`, gate, ["name"]);
      assertString(gate.name, `gate ${groupName}.name`);
      if (!gate.humanOnly) {
        assertStringArray(gate.command, `gate ${groupName}.${gate.name}.command`);
      }
    }
  }
  for (const [riskClass, route] of Object.entries(adapter.gates.routing.implementationByRisk)) {
    assertStringArray(route, `adapter.gates.routing.implementationByRisk.${riskClass}`);
  }
  for (const [riskClass, route] of Object.entries(adapter.gates.routing.deliveryByRisk)) {
    assertStringArray(route, `adapter.gates.routing.deliveryByRisk.${riskClass}`);
  }
  for (const route of [
    ...adapter.gates.routing.planReviewDefault,
    ...adapter.gates.routing.implementationDefault,
    ...adapter.gates.routing.deliveryDefault,
    ...adapter.gates.routing.deliveryFull,
    ...adapter.gates.routing.humanApproval,
    ...Object.values(adapter.gates.routing.implementationByRisk).flat(),
    ...Object.values(adapter.gates.routing.deliveryByRisk).flat()
  ]) {
    if (!gateGroupNames.has(route)) {
      throw new Error(`adapter.gates.routing references unknown gate group ${route}`);
    }
  }
  requireKeys("adapter.controlPlane", adapter.controlPlane, ["protectedPaths"]);
  assertStringArray(adapter.controlPlane.protectedPaths, "adapter.controlPlane.protectedPaths");
  requireKeys("adapter.providers", adapter.providers, ["orchestratorOrder", "capabilities"]);
  assertStringArray(adapter.providers.orchestratorOrder, "adapter.providers.orchestratorOrder");
  if (adapter.providers.capabilities === null || typeof adapter.providers.capabilities !== "object") {
    throw new Error("adapter.providers.capabilities must be an object");
  }
  for (const [provider, capability] of Object.entries(adapter.providers.capabilities)) {
    requireKeys(`adapter.providers.capabilities.${provider}`, capability, ["roles", "timeoutMs"]);
    assertStringArray(capability.roles, `adapter.providers.capabilities.${provider}.roles`);
    if (!Number.isInteger(capability.timeoutMs) || capability.timeoutMs < 1) {
      throw new Error(`adapter.providers.capabilities.${provider}.timeoutMs must be an integer`);
    }
  }
  if (adapter.riskClasses === null || typeof adapter.riskClasses !== "object") {
    throw new Error("adapter.riskClasses must be an object");
  }
  for (const [risk, policy] of Object.entries(adapter.riskClasses)) {
    requireKeys(`adapter.riskClasses.${risk}`, policy, ["reviewVendors", "strongReviewersOnly"]);
    if (!Number.isInteger(policy.reviewVendors) || policy.reviewVendors < 1) {
      throw new Error(`adapter.riskClasses.${risk}.reviewVendors must be >= 1`);
    }
    if (typeof policy.strongReviewersOnly !== "boolean") {
      throw new Error(`adapter.riskClasses.${risk}.strongReviewersOnly must be boolean`);
    }
  }
  assertStringArray(adapter.humanOnlyActions, "adapter.humanOnlyActions");
}

function serializeRegistry(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function assertExactRegistry(filePath, registry) {
  const actual = await readFile(filePath, "utf8").catch(() => null);
  const expected = serializeRegistry({ adapters: registry });
  if (actual !== expected) {
    throw new Error(`generated adapter registry drift detected: ${filePath}`);
  }
}

export function defaultAdapterRegistryPath() {
  return repoPath("adapters", "registry.json");
}

export async function syncAdapters({ check = false, outputPath = defaultAdapterRegistryPath() } = {}) {
  const adapterDir = repoPath("adapters");
  const adapterFiles = (await readdir(adapterDir))
    .filter((file) => file.endsWith(".json") && file !== path.basename(defaultAdapterRegistryPath()))
    .sort();
  const registry = [];
  for (const fileName of adapterFiles) {
    const adapter = await readJson(path.join(adapterDir, fileName));
    validateAdapter(adapter);
    registry.push({
      name: adapter.name,
      version: adapter.version,
      baseBranch: adapter.repository.baseBranch,
      requiredFiles: adapter.guidance.requiredFiles
    });
  }
  if (check) {
    await assertExactRegistry(outputPath, registry);
    return registry;
  }
  await writeJson(outputPath, { adapters: registry });
  return registry;
}
