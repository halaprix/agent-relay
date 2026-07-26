import path from "node:path";
import { readFile } from "node:fs/promises";
import { ATTRIBUTION_PATTERNS, PROTECTED_COMMAND_PATTERNS, REPO_SCAN_IGNORE_DIRS } from "./constants.mjs";
import { listFilesRecursive, relativeIsInside, toPosixRelative } from "./fs.mjs";

export function assertCommandsAllowed(commands) {
  for (const command of commands) {
    for (const pattern of PROTECTED_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(`forbidden worker command: ${command}`);
      }
    }
  }
}

export function assertOwnedPaths({ ownedPaths, changedPaths, protectedPaths, mode = "default" }) {
  for (const changedPath of changedPaths) {
    const owned = ownedPaths.some((ownedPath) => relativeIsInside(ownedPath, changedPath));
    if (!owned) {
      throw new Error(`changed path outside ownership boundary: ${changedPath}`);
    }
    const protectedHit = protectedPaths.some((protectedPath) => relativeIsInside(protectedPath, changedPath));
    if (protectedHit && mode !== "plugin-maintenance") {
      throw new Error(`protected control-plane path touched outside plugin-maintenance mode: ${changedPath}`);
    }
  }
}

export async function scanPrivacy(rootDir, { ignoreDirNames = REPO_SCAN_IGNORE_DIRS } = {}) {
  const findings = [];
  const files = await listFilesRecursive(rootDir, { ignoreDirNames });
  for (const filePath of files) {
    if (filePath.includes(`${path.sep}.git${path.sep}`) || filePath.endsWith(".png")) {
      continue;
    }
    const relativePath = toPosixRelative(rootDir, filePath);
    const text = await readFile(filePath, "utf8").catch(() => "");
    for (const pattern of ATTRIBUTION_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({ file: relativePath, issue: pattern.source });
      }
    }
    const emailMatches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    for (const match of emailMatches) {
      if (match === "git@github.com") {
        continue;
      }
      if (!match.endsWith("@example.com")) {
        findings.push({ file: relativePath, issue: `email:${match}` });
      }
    }
  }
  return findings;
}

export async function scanPrivacyInPaths(rootDir, relativePaths) {
  const findings = [];
  for (const relativePath of relativePaths) {
    const filePath = path.join(rootDir, relativePath);
    const text = await readFile(filePath, "utf8").catch(() => "");
    for (const pattern of ATTRIBUTION_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({ file: relativePath, issue: pattern.source });
      }
    }
    const emailMatches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    for (const match of emailMatches) {
      if (match === "git@github.com") {
        continue;
      }
      if (!match.endsWith("@example.com")) {
        findings.push({ file: relativePath, issue: `email:${match}` });
      }
    }
  }
  return findings;
}
