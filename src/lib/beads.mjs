import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeIssueForPrompt } from "./sanitize.mjs";

function runBd(args, env) {
  const configured = env.AGENT_RELAY_BD_BIN || "bd";
  const command = configured.endsWith(".mjs") || configured.endsWith(".js") ? process.execPath : configured;
  const finalArgs = command === process.execPath && configured !== process.execPath ? [configured, ...args] : args;
  const captureDir = mkdtempSync(path.join(os.tmpdir(), "agent-relay-bd-capture-"));
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

function assertBeadsEnv(adapter, env) {
  if (env.BEADS_DIR !== adapter.beads.requiredDir) {
    throw new Error(`BEADS_DIR must be ${adapter.beads.requiredDir}`);
  }
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

export function verifyBeadsStore({ adapter, env, beadId, claim = true, alreadyClaimed = false }) {
  assertBeadsEnv(adapter, env);
  const where = runBd(["where"], env);
  if (where.status !== 0) {
    throw new Error(`bd where failed: ${where.stderr || where.stdout}`);
  }
  const resolved = parseBdWhereOutput(where.stdout).path;
  if (resolved !== adapter.beads.requiredDir) {
    throw new Error(`wrong beads store: expected ${adapter.beads.requiredDir}, received ${resolved}`);
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

export function appendBeadComment({ env, beadId, comment }) {
  const payload = JSON.stringify(comment);
  const response = runBd(["comments", "add", beadId, payload, "--json"], env);
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
