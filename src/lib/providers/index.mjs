import claude from "./claude.mjs";
import codex from "./codex.mjs";
import agy from "./agy.mjs";
import opencode from "./opencode.mjs";

// Stable enumeration order. Nothing generated depends on this order today, but keep
// it deterministic (and matching the pre-registry order: claude, codex, agy, then the
// newer opencode addition appended) so any future ordering-sensitive consumer inherits a
// sane default rather than import order.
export const PROVIDERS = [claude, codex, agy, opencode];

export function findProvider(name) {
  const provider = PROVIDERS.find((candidate) => candidate.name === name);
  if (!provider) {
    throw new Error(`unknown provider: ${name}`);
  }
  return provider;
}
