import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeIssueForPrompt } from "./sanitize.mjs";

function runBd(args, env) {
  const configured = env.AGENT_RELAY_BD_BIN || "bd";
  const command = configured.endsWith(".mjs") || configured.endsWith(".js") ? process.execPath : configured;
  const finalArgs = command === process.execPath && configured !== process.execPath ? [configured, ...args] : args;
  const captureDir = mkdtempSync(path.join(os.tmpdir(), "agent-relay-bd-capture-"));
  try {
    const stdoutPath = path.join(captureDir, "stdout.log");
    const stderrPath = path.join(captureDir, "stderr.log");
    const result = spawnSync(command, finalArgs, {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        AGENT_RELAY_STDOUT_FILE: stdoutPath,
        AGENT_RELAY_STDERR_FILE: stderrPath
      }
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout || readFileSync(stdoutPath, { encoding: "utf8", flag: "a+" }),
      stderr: result.stderr || readFileSync(stderrPath, { encoding: "utf8", flag: "a+" })
    };
  } finally {
    try {
      rmSync(captureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // swallow cleanup failures - never mask the original result/error
    }
  }
}

function normalizeBdPayload(payload) {
  const parsed = JSON.parse(payload);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function normalizeBdList(payload) {
  const parsed = JSON.parse(payload);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return parsed ? [parsed] : [];
}

export function parseBdWhereOutput(output) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("bd where returned no output");
  }
  return {
    path: lines[0],
    details: lines.slice(1)
  };
}

function beadsEnv(env, beadsDir) {
  return { ...env, BEADS_DIR: beadsDir };
}

export function epicIdFor(beadId) {
  const separator = String(beadId || "").indexOf(".");
  return separator === -1 ? String(beadId || "") : String(beadId).slice(0, separator);
}

// Null means "could not tell", which is different from "has no children". Enforcement that
// blocks a run must never act on a guess, so callers treat null as permission to proceed.
export function listBeadChildren({ env, beadId, beadsDir = null }) {
  const response = runBd(["list", "--parent", beadId, "--json"], beadsDir ? beadsEnv(env, beadsDir) : env);
  if (response.status !== 0) {
    return null;
  }
  try {
    return normalizeBdList(response.stdout).filter((child) => child && child.id);
  } catch {
    return null;
  }
}

// An adapter's beads.memoryKey is not optional metadata: verifyBeadsStore hard-refuses
// every plan/run/resume/review with "required memory key missing" unless a `bd remember`
// entry under that exact key already exists in the project's store. A freshly generated
// adapter would therefore be broken on its very first use unless something seeds that
// memory - this is that something, used by `relay init` right after it writes the
// adapter, and only when a beads store already exists to seed it into.
export function rememberProjectMemory({ env, beadsDir, key, content }) {
  const response = runBd(["remember", content, "--key", key], beadsEnv(env, beadsDir));
  if (response.status !== 0) {
    throw new Error(`bd remember failed: ${response.stderr || response.stdout}`);
  }
  return response.stdout.trim();
}

// Exports every issue as JSONL on stdout. Deliberately never writes the file: an
// exported `.beads/issues.jsonl` carries `created_by` identities plus every title,
// description, and comment, it is not gitignored, and the privacy scanner skips
// `.beads` - so a file on disk is two blind guards away from a public commit.
export function exportBeadRecords({ env, beadsDir = null }) {
  const response = runBd(["export", "--readonly"], beadsDir ? beadsEnv(env, beadsDir) : env);
  if (response.status !== 0) {
    throw new Error(`bd export failed: ${response.stderr || response.stdout}`);
  }
  const records = [];
  for (const line of response.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = JSON.parse(trimmed);
    if (parsed && parsed.id) {
      records.push(parsed);
    }
  }
  return records;
}

export function storePathMatches(resolvedPath, beadsDir) {
  const normalizedStore = path.resolve(beadsDir);
  const normalizedResolved = path.resolve(resolvedPath);
  const relative = path.relative(normalizedStore, normalizedResolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertDependenciesResolved(issue) {
  const blocked = Array.isArray(issue.dependencies)
    ? issue.dependencies.filter((dependency) => dependency.status && !["closed", "done", "resolved"].includes(dependency.status))
    : [];
  if (blocked.length > 0) {
    throw new Error(`issue has unresolved dependencies: ${blocked.map((item) => item.id).join(", ")}`);
  }
}

function parseCommentRecord(comment) {
  const rawText =
    comment.text ??
    comment.comment ??
    comment.body ??
    comment.message ??
    "";
  try {
    const parsed = JSON.parse(rawText);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractCheckpointComments(comments) {
  return comments
    .map(parseCommentRecord)
    .filter((comment) => comment && comment.kind === "agent-relay-checkpoint");
}

function extractApprovalComments(comments) {
  return comments
    .map(parseCommentRecord)
    .filter((comment) => comment && comment.kind === "agent-relay-plan-approval");
}

function extractPlanReviewComments(comments) {
  return comments
    .map(parseCommentRecord)
    .filter((comment) => comment && comment.kind === "agent-relay-plan-review");
}

export function approvalForSpecHash(comments, specHash) {
  return extractApprovalComments(comments).find((comment) => comment.specHash === specHash) || null;
}

export function planReviewsForSpecHash(comments, specHash) {
  return extractPlanReviewComments(comments).filter((comment) => comment.specHash === specHash);
}

export function verifyBeadsStore({ adapter, env, beadId, beadsDir, claim = true, alreadyClaimed = false }) {
  const storeDir = beadsDir || adapter.beads.requiredDir;
  env = beadsEnv(env, storeDir);
  const where = runBd(["where"], env);
  if (where.status !== 0) {
    throw new Error(`bd where failed: ${where.stderr || where.stdout}`);
  }
  const resolved = parseBdWhereOutput(where.stdout).path;
  if (!storePathMatches(resolved, storeDir)) {
    throw new Error(`wrong beads store: expected ${storeDir}, received ${resolved}`);
  }
  const prime = runBd(["prime"], env);
  const hasMemoryBody = prime.stdout.includes(adapter.beads.memoryKey);
  if (!hasMemoryBody) {
    const memories = runBd(["memories", "--json"], env);
    if (memories.status !== 0) {
      throw new Error(`bd memories --json failed: ${memories.stderr || memories.stdout}`);
    }
    if (!memories.stdout.includes(adapter.beads.memoryKey)) {
      throw new Error(`required memory key missing: ${adapter.beads.memoryKey}`);
    }
  }
  const issueResponse = runBd(["show", beadId, "--json"], env);
  if (issueResponse.status !== 0) {
    throw new Error(`bd show failed for ${beadId}: ${issueResponse.stderr || issueResponse.stdout}`);
  }
  const bead = normalizeBdPayload(issueResponse.stdout);
  assertDependenciesResolved(bead);
  if (bead.claimConflict) {
    throw new Error(`issue ${beadId} has a conflicting claim`);
  }
  const commentsResponse = runBd(["comments", beadId, "--json"], env);
  if (commentsResponse.status !== 0) {
    throw new Error(`bd comments failed for ${beadId}: ${commentsResponse.stderr || commentsResponse.stdout}`);
  }
  const comments = normalizeBdList(commentsResponse.stdout);
  let claimResult = null;
  if (claim && !alreadyClaimed) {
    const claimCommand = runBd(["update", beadId, "--claim", "--json"], env);
    if (claimCommand.status !== 0) {
      throw new Error(`bd claim failed for ${beadId}: ${claimCommand.stderr || claimCommand.stdout}`);
    }
    claimResult = normalizeBdPayload(claimCommand.stdout);
  }
  return {
    store: resolved,
    bead,
    comments,
    claim: claimResult,
    sanitized: sanitizeIssueForPrompt(bead),
    checkpoints: extractCheckpointComments(comments),
    approvals: extractApprovalComments(comments)
  };
}

export function appendBeadComment({ env, beadId, comment, beadsDir = null }) {
  const payload = JSON.stringify(comment);
  const response = runBd(["comments", "add", beadId, payload, "--json"], beadsDir ? beadsEnv(env, beadsDir) : env);
  if (response.status !== 0) {
    throw new Error(`bd comments add failed for ${beadId}: ${response.stderr || response.stdout}`);
  }
  return normalizeBdPayload(response.stdout);
}

export function rebuildStateFromBeadComments(checkpoints) {
  const state = {};
  for (const checkpoint of checkpoints) {
    if (checkpoint.statePatch && typeof checkpoint.statePatch === "object") {
      Object.assign(state, checkpoint.statePatch);
    }
  }
  return state;
}
