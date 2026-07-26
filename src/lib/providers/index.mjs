import claude from "./claude.mjs";
import codex from "./codex.mjs";
import agy from "./agy.mjs";

// Stable enumeration order. Nothing generated depends on this order today, but keep
// it deterministic (and matching the pre-registry order: claude, codex, agy) so any
// future ordering-sensitive consumer inherits a sane default rather than import order.
export const PROVIDERS = [claude, codex, agy];

export function findProvider(name) {
  const provider = PROVIDERS.find((candidate) => candidate.name === name);
  if (!provider) {
    throw new Error(`unknown provider: ${name}`);
  }
  return provider;
}
