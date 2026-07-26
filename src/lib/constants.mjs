import { PROVIDERS } from "./providers/index.mjs";

export const EXIT_CLASSES = {
  success: 0,
  "human-action-required": 10,
  "provider-quorum-unavailable": 11,
  "project-misconfigured": 12,
  "unrecoverable-run-state": 13
};

export const PROTECTED_COMMAND_PATTERNS = [
  /\bgit\s+add\s+\./i,
  /\bgit\s+add\s+-A\b/i,
  /\bgit\s+commit\s+-a\b/i,
  /\bgit\s+push\b.*--force/i,
  /\bgit\s+remote\b/i,
  /\bgit\s+fetch\b/i,
  /\bgit\s+pull\b/i,
  /\bbd\s+/i,
  /\bgh\s+/i
];

// chatgpt/gemini have no provider module here: neither ships a role bundle, a repo
// directory, or a renderer/parser, so they don't fit the registry's manifest shape.
// They are still attribution names the privacy scanner must recognize (a teammate's
// commit could credit either tool by name without agent-relay ever driving one), so
// they are kept as extra literal aliases layered on top of the registry-derived
// provider names rather than force-fit into claude's or codex's manifest (which would
// incorrectly imply agent-relay treats them as that provider).
const EXTRA_ATTRIBUTION_ALIASES = ["chatgpt", "gemini"];

const ATTRIBUTION_NAMES = [
  ...PROVIDERS.flatMap((provider) => provider.attributionAliases),
  ...EXTRA_ATTRIBUTION_ALIASES
];
const ATTRIBUTION_ALTERNATION = ATTRIBUTION_NAMES.join("|");

export const ATTRIBUTION_PATTERNS = [
  new RegExp(`co-authored-by:\\s*(${ATTRIBUTION_ALTERNATION})`, "i"),
  new RegExp(`generated with (${ATTRIBUTION_ALTERNATION})`, "i"),
  new RegExp(`authored by (${ATTRIBUTION_ALTERNATION})`, "i"),
  /ai[- ]generated/i
];

export const RESOURCES_DIR_NAME = ".resources";

export const SNAPSHOT_IGNORE_PREFIXES = [".git", ".agents/agent-relay", ".agent-relay-sandbox", RESOURCES_DIR_NAME];

export const REPO_SCAN_IGNORE_DIRS = [".git", "node_modules", ".beads", RESOURCES_DIR_NAME];

export const ROLE_ORDER = ["orchestrator", "coder", "reviewer"];

export const HOOK_EVENTS = ["PreToolUse", "Stop"];
