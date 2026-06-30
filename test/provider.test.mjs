import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderFailure, parseWorkerReport } from "../src/lib/provider.mjs";

test("parseWorkerReport accepts pure json", () => {
  const report = parseWorkerReport('{"status":"success","summary":"ok","ownedPaths":[],"commandsAttempted":[],"changedPaths":[]}');
  assert.equal(report.status, "success");
});

test("parseWorkerReport falls back to final json line", () => {
  const report = parseWorkerReport('debug line\n{"status":"success","summary":"ok","ownedPaths":[],"commandsAttempted":[],"changedPaths":[]}');
  assert.equal(report.summary, "ok");
});

test("classifyProviderFailure detects quota and timeout failures", () => {
  assert.equal(classifyProviderFailure({ stdout: "", stderr: "quota exceeded" }), "handoff-immediate");
  assert.equal(classifyProviderFailure({ stdout: "", stderr: "network timeout" }), "handoff-after-retry");
});
