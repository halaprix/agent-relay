import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { view } from "../src/lib/supervisor.mjs";
import { buildViewerArgs, buildViewerEnv, resolveViewerCommand } from "../src/lib/viewer.mjs";
import { repoPath } from "../src/lib/paths.mjs";
import { beadsDirFor, cleanupFixtures, createProjectFixture, fixtureDir } from "./helpers.mjs";

test.after(cleanupFixtures);

test("the viewer is launched through npx, so it is never a dependency", () => {
  // Agent Relay ships zero runtime dependencies and the viewer ships a React bundle;
  // fetching it on demand is what keeps that true.
  const resolved = resolveViewerCommand({});
  assert.equal(resolved.command, "npx");
  assert.deepEqual(resolved.args, ["-y", "@halaprix/beads-viewer"]);

  // Overridable the same way AGENT_RELAY_BD_BIN is, for a local checkout or a test.
  assert.deepEqual(resolveViewerCommand({ AGENT_RELAY_VIEWER_BIN: "/opt/viewer" }), {
    command: "/opt/viewer",
    args: []
  });
  const script = resolveViewerCommand({ AGENT_RELAY_VIEWER_BIN: "/opt/viewer.mjs" });
  assert.equal(script.command, process.execPath);
  assert.deepEqual(script.args, ["/opt/viewer.mjs"]);
});

test("the store is passed explicitly, overriding an inherited BEADS_DIR", () => {
  // The trap this exists to close: an exported BEADS_DIR pointing elsewhere silently wins
  // over repository discovery, so the viewer would edit another project's issues.
  const built = buildViewerEnv({
    beadsDir: "/project/.beads",
    env: { BEADS_DIR: "/somewhere/else/.beads", PATH: "/usr/bin" }
  });
  assert.equal(built.BEADS_DIR, "/project/.beads");
  assert.equal(built.PATH, "/usr/bin");
});

test("arguments are only passed when asked for", () => {
  assert.deepEqual(buildViewerArgs({}), []);
  assert.deepEqual(buildViewerArgs({ beadId: "x-1", port: 8080, open: false }), [
    "--bead",
    "x-1",
    "--port",
    "8080",
    "--no-open"
  ]);
});

test("view hands the project store to the viewer and reports its exit", { timeout: 15000 }, async () => {
  const projectRoot = await createProjectFixture();
  const reportPath = path.join(await fixtureDir("agent-relay-viewer-"), "report.json");
  const result = await view({
    projectRoot,
    adapterName: "example-app",
    beadId: "example-app-123",
    port: 7777,
    open: false,
    env: {
      AGENT_RELAY_VIEWER_BIN: repoPath("test", "fixtures", "fake-viewer.mjs"),
      FAKE_VIEWER_REPORT: reportPath,
      PATH: process.env.PATH
    }
  });
  assert.equal(result.ok, true);

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.deepEqual(report.argv, ["--bead", "example-app-123", "--port", "7777", "--no-open"]);
  assert.equal(report.beadsDir, beadsDirFor(projectRoot));
  assert.equal(report.cwd, projectRoot);
});

test("a missing store is reported before the viewer is launched", { timeout: 15000 }, async () => {
  const projectRoot = await createProjectFixture();
  await (await import("node:fs/promises")).rm(beadsDirFor(projectRoot), { recursive: true, force: true });
  const result = await view({
    projectRoot,
    adapterName: "example-app",
    env: { AGENT_RELAY_VIEWER_BIN: repoPath("test", "fixtures", "fake-viewer.mjs"), PATH: process.env.PATH }
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitClass, "project-misconfigured");
  assert.match(result.error, /missing beads store/);
});

test("a viewer that cannot be run is a configuration problem, not a crash", { timeout: 15000 }, async () => {
  const projectRoot = await createProjectFixture();
  const result = await view({
    projectRoot,
    adapterName: "example-app",
    env: { AGENT_RELAY_VIEWER_BIN: "/definitely/not/a/real/viewer", PATH: process.env.PATH }
  });
  assert.equal(result.exitClass, "project-misconfigured");
  assert.match(result.error, /could not run/);
});

test("a viewer exiting non-zero asks for a human, rather than reporting a run failure", { timeout: 15000 }, async () => {
  const projectRoot = await createProjectFixture();
  const reportPath = path.join(await fixtureDir("agent-relay-viewer-fail-"), "report.json");
  const result = await view({
    projectRoot,
    adapterName: "example-app",
    env: {
      AGENT_RELAY_VIEWER_BIN: repoPath("test", "fixtures", "fake-viewer.mjs"),
      FAKE_VIEWER_REPORT: reportPath,
      FAKE_VIEWER_EXIT: "3",
      PATH: process.env.PATH
    }
  });
  assert.equal(result.exitClass, "human-action-required");
  // The class's code, not the viewer's: a detail field must never shadow the contract.
  assert.equal(result.exitCode, 10);
  assert.equal(result.viewerExitCode, 3);
});
