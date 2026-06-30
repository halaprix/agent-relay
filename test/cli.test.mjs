import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../src/lib/cli.mjs";

test("parseCliArgs handles --json and options", () => {
  const parsed = parseCliArgs(["--json", "setup", "--adapter", "example-app"]);
  assert.equal(parsed.command, "setup");
  assert.equal(parsed.options.adapter, "example-app");
  assert.equal(parsed.json, true);
});

test("parseCliArgs keeps positionals in order", () => {
  const parsed = parseCliArgs(["gates", "example-app-123", "pre-push"]);
  assert.deepEqual(parsed.positionals, ["example-app-123", "pre-push"]);
});
