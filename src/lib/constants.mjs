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

export const ATTRIBUTION_PATTERNS = [
  /co-authored-by:\s*(claude|codex|chatgpt|gemini|agy)/i,
  /generated with (claude|codex|chatgpt|gemini|agy)/i,
  /authored by (claude|codex|chatgpt|gemini|agy)/i,
  /ai[- ]generated/i
];

export const ROLE_ORDER = ["orchestrator", "coder", "reviewer"];

export const HOOK_EVENTS = ["PreToolUse", "Stop"];
