import { readJson } from "./fs.mjs";
import { repoPath } from "./paths.mjs";

export async function loadSchema(name) {
  return readJson(repoPath("schemas", name));
}

export function requireKeys(label, value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of keys) {
    if (!(key in value)) {
      throw new Error(`${label} missing required field ${key}`);
    }
  }
}

export function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`${label} must be a non-empty string array`);
  }
}
