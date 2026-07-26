import { PROVIDERS } from "./providers/index.mjs";

export function sanitizePromptText(value, { maxLength = 4000 } = {}) {
  const text = String(value ?? "")
    .replace(/\r/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const DEFAULT_TEAM_FACING_PROVIDER_NAMES = PROVIDERS.map((provider) => provider.name);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCaseInsensitivePattern(value, pattern) {
  return value.replace(pattern, " ");
}

export function sanitizeTeamFacingText(value, { beadId = "", providerNames = DEFAULT_TEAM_FACING_PROVIDER_NAMES, maxLength = 400 } = {}) {
  let text = sanitizePromptText(value, { maxLength: 2000 });
  if (beadId) {
    text = stripCaseInsensitivePattern(text, new RegExp(`\\b${escapeRegExp(beadId)}\\b`, "gi"));
  }
  if (providerNames.length > 0) {
    text = stripCaseInsensitivePattern(
      text,
      new RegExp(`\\b(?:${providerNames.map(escapeRegExp).join("|")})\\b`, "gi")
    );
  }
  text = stripCaseInsensitivePattern(text, /\b[a-z0-9]+(?:-[a-z0-9]+)*-\d+\b/gi);
  text = text.replace(/[\s_-]+/g, " ").trim();
  return sanitizePromptText(text || "work item", { maxLength });
}

export function assertTeamFacingTextClean(value, { beadId = "", providerNames = DEFAULT_TEAM_FACING_PROVIDER_NAMES } = {}) {
  const text = String(value ?? "");
  if (beadId && new RegExp(`\\b${escapeRegExp(beadId)}\\b`, "i").test(text)) {
    throw new Error(`team-facing text must not include bead id ${beadId}`);
  }
  for (const providerName of providerNames) {
    if (new RegExp(`\\b${escapeRegExp(providerName)}\\b`, "i").test(text)) {
      throw new Error(`team-facing text must not include provider name ${providerName}`);
    }
  }
  return text;
}

export function sanitizeIssueForPrompt(issue) {
  return {
    id: sanitizePromptText(issue.id, { maxLength: 200 }),
    title: sanitizePromptText(issue.title, { maxLength: 400 }),
    description: sanitizePromptText(issue.description || "", { maxLength: 8000 }),
    design: sanitizePromptText(issue.design || "", { maxLength: 8000 }),
    acceptance: sanitizePromptText(issue.acceptance_criteria || issue.acceptance || "", { maxLength: 4000 }),
    dependencies: Array.isArray(issue.dependencies)
      ? issue.dependencies.map((dependency) => ({
          id: sanitizePromptText(dependency.id || "", { maxLength: 200 }),
          status: sanitizePromptText(dependency.status || "", { maxLength: 80 })
        }))
      : []
  };
}

export function slugifyTitle(value, { maxLength = 48 } = {}) {
  const slug = sanitizePromptText(value, { maxLength: 512 })
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.slice(0, maxLength).replace(/-+$/g, "") || "work-item";
}
