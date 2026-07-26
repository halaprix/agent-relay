import { parseFrontmatter, renderBody } from "./shared.mjs";

// opencode agent frontmatter observed via `opencode agent create` (see
// .resources/opencode/agent-format-and-events.md): description, mode, and a tools map
// where ABSENT means enabled and explicit `false` means disabled. The capture never
// showed a `name` field — the agent's identity is its filename, not frontmatter content
// — so this manifest does not emit one either, to avoid writing a shape opencode's own
// generator does not produce.
const MODE_BY_ROLE = {
  orchestrator: "primary",
  coder: "primary",
  reviewer: "subagent"
};

// Only tools a role must NOT have appear here; every other tool in opencode's vocabulary
// (bash, read, write, edit, list, glob, grep, webfetch, task, todowrite, todoread) is left
// enabled by omission.
const DISABLED_TOOLS_BY_ROLE = {
  // Drives worktrees and Beads via bash, spawns workers (task), and caches external
  // reference material under .resources/ (webfetch) — needs the full tool set.
  orchestrator: [],
  // A leaf worker (see coder.json rules): never spawns further agents and never fetches
  // fresh external material — .resources/ is read-only background context to it.
  coder: ["task", "webfetch"],
  // Review is read-only over a supplied diff/evidence bundle (see reviewer.json rules):
  // must never write or edit, never spawns workers, and never fetches fresh external
  // content — .resources/ is an unreviewed cache it must not draw on either.
  reviewer: ["write", "edit", "task", "webfetch"]
};

function renderRole(role, roleModel) {
  const disabledTools = DISABLED_TOOLS_BY_ROLE[role.roleKey] || [];
  const lines = ["---", `description: ${role.description}`, `mode: ${MODE_BY_ROLE[role.roleKey]}`];
  if (disabledTools.length > 0) {
    lines.push("tools:");
    for (const tool of disabledTools) {
      lines.push(`  ${tool}: false`);
    }
  }
  // opencode has no reasoning-effort flag, unlike claude/codex/agy's `effort` field — so
  // roleDefaults below intentionally has no `effort` key and none is rendered here.
  lines.push(`model: ${roleModel.model}`, "---");
  return `${lines.join("\n")}\n${renderBody(role)}\n`;
}

// Recognized upstream-provider prefixes opencode's `-m provider/model` argument can name.
// This is a fact about an aggregator's naming convention, observed only for opencode's own
// hosted catalog (opencode/gpt-5-nano, opencode/grok-code, ...) which all use the
// "opencode" prefix itself (resolves to null — genuinely unknown vendor, by design). The
// anthropic/openai/google entries are what an operator would need to route directly to a
// vendor; they are unverified against opencode's real model catalog and will go stale
// whenever the aggregator renames or adds providers.
const KNOWN_PROVIDER_PREFIXES = new Set(["anthropic", "openai", "google"]);

function extractModelArg(providerConfig) {
  const args = providerConfig?.args;
  if (Array.isArray(args)) {
    for (let index = 0; index < args.length; index += 1) {
      if ((args[index] === "-m" || args[index] === "--model") && typeof args[index + 1] === "string") {
        return args[index + 1];
      }
    }
  }
  return typeof providerConfig?.model === "string" ? providerConfig.model : null;
}

// opencode is model-agnostic: the vendor actually driving a run is a property of the
// configured model argument, not of the CLI, unlike claude/codex/agy's fixed-vendor
// manifests (see the comment above providerVendor in provider.mjs for why those omit
// this). Returns null — never a guess — when there is no model argument or its prefix is
// unrecognized, so the caller safely falls through to the declared vendor.
function resolveVendor(providerConfig) {
  const modelValue = extractModelArg(providerConfig);
  if (typeof modelValue !== "string" || !modelValue.includes("/")) {
    return null;
  }
  const prefix = modelValue.split("/")[0].trim().toLowerCase();
  return KNOWN_PROVIDER_PREFIXES.has(prefix) ? prefix : null;
}

export default {
  name: "opencode",
  extension: "md",
  renderRole,
  parseRole: parseFrontmatter,
  // CONFIRMED by a throwaway probe (2026-07-26): `opencode agent create --path .opencode
  // --description x --mode subagent --tools read` in a scratch dir wrote
  // `.opencode/agent/<generated-name>.md` — i.e. `--path` is literally prepended to the
  // fixed `agent/` segment. So the on-disk convention is `.opencode/agent/`, matching the
  // other three providers' dot-directory convention (.claude-plugin, .codex, .agents).
  repoBundleDir: [".opencode", "agent"],
  projectDir: [".opencode", "agent"],
  attributionAliases: ["opencode"],
  resolveVendor,
  // Provider-owned per-role defaults, keyed by canonical role name (see ROLE_ORDER in
  // constants.mjs). Models are opencode's own hosted catalog (`opencode models`):
  // - orchestrator/coder: grok-code, a coding-focused frontier model — suits both the
  //   orchestrator's routing/judgment calls and the coder's implementation work, mirroring
  //   how claude/codex reuse one base model across both roles.
  // - reviewer: glm-4.7-free, a different model family from grok-code/claude/codex/agy's
  //   defaults, so a review that includes opencode gets a genuinely independent second
  //   opinion rather than restating the coder's own model's judgment; free tier keeps the
  //   review role's cost bounded.
  // No `effort` key: opencode has no reasoning-effort flag (see renderRole above).
  roleDefaults: {
    orchestrator: { model: "opencode/grok-code" },
    coder: { model: "opencode/grok-code" },
    reviewer: { model: "opencode/glm-4.7-free" }
  }
};
