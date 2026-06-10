import path from "node:path";
import { readdir } from "node:fs/promises";
import { readJson, writeJson } from "./fs.mjs";
import { repoPath } from "./paths.mjs";
import { assertString, assertStringArray, requireKeys } from "./schema.mjs";

export async function loadAdapter(adapterName) {
  const adapterPath = repoPath("adapters", `${adapterName}.json`);
  const adapter = await readJson(adapterPath);
  validateAdapter(adapter);
  return { adapter, adapterPath };
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
  requireKeys("adapter.gates", adapter.gates, ["groups"]);
  if (adapter.gates.groups === null || typeof adapter.gates.groups !== "object") {
    throw new Error("adapter.gates.groups must be an object");
  }
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

export async function syncAdapters({ check = false } = {}) {
  const adapterDir = repoPath("adapters");
  const adapterFiles = (await readdir(adapterDir)).filter((file) => file.endsWith(".json")).sort();
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
  if (!check) {
    await writeJson(repoPath(".generated", "adapters.json"), { adapters: registry });
  }
  return registry;
}
