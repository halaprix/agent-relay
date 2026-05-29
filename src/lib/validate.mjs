import { assertString, assertStringArray, requireKeys } from "./schema.mjs";

function rejectUnknownKeys(label, value, allowedKeys) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} contains unexpected key ${key}`);
    }
  }
}

export function validateWorkerReport(report) {
  requireKeys("worker report", report, [
    "status",
    "summary",
    "ownedPaths",
    "commandsAttempted",
    "changedPaths"
  ]);
  rejectUnknownKeys(
    "worker report",
    report,
    new Set(["status", "summary", "ownedPaths", "commandsAttempted", "changedPaths", "gatesClaimed", "artifacts"])
  );
  if (!["success", "needs-fix", "provider-failure", "human-action-required"].includes(report.status)) {
    throw new Error("worker report status is invalid");
  }
  assertString(report.summary, "worker report.summary");
  assertStringArray(report.ownedPaths, "worker report.ownedPaths");
  assertStringArray(report.commandsAttempted, "worker report.commandsAttempted");
  assertStringArray(report.changedPaths, "worker report.changedPaths");
  if (report.artifacts !== undefined) {
    assertStringArray(report.artifacts, "worker report.artifacts");
  }
  return report;
}

export function validateReviewReport(report) {
  requireKeys("review report", report, [
    "status",
    "summary",
    "findings",
    "commandsAttempted"
  ]);
  rejectUnknownKeys(
    "review report",
    report,
    new Set(["status", "summary", "findings", "commandsAttempted", "artifacts"])
  );
  if (!["success", "needs-fix"].includes(report.status)) {
    throw new Error("review report status is invalid");
  }
  assertString(report.summary, "review report.summary");
  assertStringArray(report.commandsAttempted, "review report.commandsAttempted");
  if (!Array.isArray(report.findings)) {
    throw new Error("review report.findings must be an array");
  }
  for (const finding of report.findings) {
    requireKeys("review finding", finding, ["severity", "title"]);
    assertString(finding.severity, "review finding.severity");
    assertString(finding.title, "review finding.title");
    if (finding.file !== undefined) {
      assertString(finding.file, "review finding.file");
    }
  }
  return report;
}
