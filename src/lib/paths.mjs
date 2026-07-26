import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCES_DIR_NAME } from "./constants.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(moduleDir, "../..");

export function repoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

export function projectStateRoot(projectRoot) {
  return path.join(projectRoot, ".agents", "agent-relay");
}

export function runStatePath(projectRoot, beadId) {
  return path.join(projectStateRoot(projectRoot), "state", `${beadId}.json`);
}

export function runLedgerPath(projectRoot, beadId) {
  return path.join(projectStateRoot(projectRoot), "state", `${beadId}.jsonl`);
}

export function projectResourcesRoot(projectRoot, resourcesRoot = RESOURCES_DIR_NAME) {
  return path.join(projectRoot, resourcesRoot);
}

export function projectConfigPath(projectRoot) {
  return path.join(projectStateRoot(projectRoot), "config.json");
}
