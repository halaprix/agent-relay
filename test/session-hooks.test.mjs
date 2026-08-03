import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildPrimeCommand, ensureSessionHooks, mergeSessionHook } from "../src/lib/session-hooks.mjs";
import { readJson, writeJson } from "../src/lib/fs.mjs";
import { cleanupFixtures, fixtureDir } from "./helpers.mjs";

test.after(cleanupFixtures);

// A SessionStart hook fires before any instruction file can be read, so it is the one place
// where model-readable guidance cannot save a misconfiguration. `bd init` writes a bare
// `bd prime --hook-json`, which on a machine exporting a global BEADS_DIR primes another
// project's store on every session start. These tests pin the merge behaviour that upgrades
// such a hook in place without ever destroying what a human already had in the file.

const ADAPTER = { beads: { requiredDir: ".beads" } };
const EVENT = "SessionStart";
const SCOPED = 'BEADS_DIR="$CLAUDE_PROJECT_DIR/.beads" bd prime --hook-json';

test("buildPrimeCommand scopes a relative store to the harness project variable", () => {
  assert.equal(buildPrimeCommand({ projectDirVar: "CLAUDE_PROJECT_DIR", requiredDir: ".beads" }), SCOPED);
});

test("buildPrimeCommand leaves an absolute store alone", () => {
  // Prefixing a project root onto an already-absolute path would name a directory that
  // cannot exist.
  assert.equal(
    buildPrimeCommand({ projectDirVar: "CLAUDE_PROJECT_DIR", requiredDir: "/srv/shared/.beads" }),
    'BEADS_DIR="/srv/shared/.beads" bd prime --hook-json'
  );
});

test("mergeSessionHook adds a hook to empty or absent settings", () => {
  for (const input of [undefined, null, {}, "not an object", []]) {
    const { settings, action } = mergeSessionHook(input, { event: EVENT, command: SCOPED });
    assert.equal(action, "added");
    assert.deepEqual(settings.hooks[EVENT], [{ matcher: "", hooks: [{ type: "command", command: SCOPED }] }]);
  }
});

test("mergeSessionHook upgrades an unscoped bd prime hook in place rather than duplicating it", () => {
  const existing = {
    hooks: {
      [EVENT]: [{ matcher: "", hooks: [{ type: "command", command: "bd prime --hook-json" }] }]
    }
  };
  const { settings, action } = mergeSessionHook(existing, { event: EVENT, command: SCOPED });
  assert.equal(action, "upgraded");
  assert.equal(settings.hooks[EVENT].length, 1, "must not append a second, conflicting hook");
  assert.equal(settings.hooks[EVENT][0].hooks.length, 1);
  assert.equal(settings.hooks[EVENT][0].hooks[0].command, SCOPED);
});

test("mergeSessionHook is a no-op when the hook already scopes BEADS_DIR", () => {
  const existing = {
    hooks: { [EVENT]: [{ matcher: "", hooks: [{ type: "command", command: SCOPED }] }] }
  };
  const { settings, action } = mergeSessionHook(existing, { event: EVENT, command: SCOPED });
  assert.equal(action, "unchanged");
  assert.deepEqual(settings.hooks[EVENT], existing.hooks[EVENT]);
});

test("mergeSessionHook respects a differently-scoped hook a human wrote", () => {
  // Any BEADS_DIR-carrying variant is treated as deliberate. Rewriting it would override a
  // local decision this function cannot evaluate.
  const custom = 'BEADS_DIR="$CLAUDE_PROJECT_DIR/.beads" bd prime --hook-json --quiet';
  const { settings, action } = mergeSessionHook(
    { hooks: { [EVENT]: [{ matcher: "", hooks: [{ type: "command", command: custom }] }] } },
    { event: EVENT, command: SCOPED }
  );
  assert.equal(action, "unchanged");
  assert.equal(settings.hooks[EVENT][0].hooks[0].command, custom);
});

test("mergeSessionHook preserves unrelated settings, events, and sibling hooks", () => {
  const existing = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo done" }] }],
      [EVENT]: [
        { matcher: "", hooks: [{ type: "command", command: "echo unrelated" }] },
        { matcher: "", hooks: [{ type: "command", command: "bd prime --hook-json" }] }
      ]
    }
  };
  const { settings, action } = mergeSessionHook(existing, { event: EVENT, command: SCOPED });
  assert.equal(action, "upgraded");
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test)"] });
  assert.deepEqual(settings.hooks.Stop, existing.hooks.Stop);
  assert.equal(settings.hooks[EVENT][0].hooks[0].command, "echo unrelated");
  assert.equal(settings.hooks[EVENT][1].hooks[0].command, SCOPED);
});

test("mergeSessionHook does not mutate the object it was given", () => {
  const existing = {
    hooks: { [EVENT]: [{ matcher: "", hooks: [{ type: "command", command: "bd prime --hook-json" }] }] }
  };
  mergeSessionHook(existing, { event: EVENT, command: SCOPED });
  assert.equal(existing.hooks[EVENT][0].hooks[0].command, "bd prime --hook-json");
});

test("ensureSessionHooks skips a project that does not use the provider", async () => {
  const projectRoot = await fixtureDir("agent-relay-hooks-absent-");
  const records = await ensureSessionHooks({ projectRoot, adapter: ADAPTER });
  assert.deepEqual(records, [], "no .claude directory means Claude is not set up here");
});

test("ensureSessionHooks creates settings.json when the provider directory exists", async () => {
  const projectRoot = await fixtureDir("agent-relay-hooks-create-");
  await mkdir(path.join(projectRoot, ".claude"), { recursive: true });

  const records = await ensureSessionHooks({ projectRoot, adapter: ADAPTER });
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, "claude");
  assert.equal(records[0].action, "added");

  const settings = await readJson(path.join(projectRoot, ".claude", "settings.json"));
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, SCOPED);
});

test("ensureSessionHooks upgrades the exact hook bd init leaves behind", async () => {
  const projectRoot = await fixtureDir("agent-relay-hooks-upgrade-");
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeJson(settingsPath, {
    hooks: { SessionStart: [{ matcher: "", hooks: [{ command: "bd prime --hook-json", type: "command" }] }] }
  });

  const records = await ensureSessionHooks({ projectRoot, adapter: ADAPTER });
  assert.equal(records[0].action, "upgraded");
  const settings = await readJson(settingsPath);
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, SCOPED);
});

test("ensureSessionHooks is idempotent across repeated runs", async () => {
  const projectRoot = await fixtureDir("agent-relay-hooks-idempotent-");
  await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
  const first = await ensureSessionHooks({ projectRoot, adapter: ADAPTER });
  assert.equal(first[0].action, "added");
  const second = await ensureSessionHooks({ projectRoot, adapter: ADAPTER });
  assert.equal(second[0].action, "unchanged");
  const third = await ensureSessionHooks({ projectRoot, adapter: ADAPTER });
  assert.equal(third[0].action, "unchanged");
});

test("ensureSessionHooks reports malformed settings instead of overwriting them", async () => {
  const projectRoot = await fixtureDir("agent-relay-hooks-malformed-");
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const original = "{ this is not json";
  await writeFile(settingsPath, original, "utf8");

  const records = await ensureSessionHooks({ projectRoot, adapter: ADAPTER });
  assert.equal(records[0].action, "skipped");
  assert.match(records[0].error, /could not parse/);
  assert.equal(await readFile(settingsPath, "utf8"), original, "an unparseable file is never clobbered");
});

test("ensureSessionHooks does nothing without a usable beads directory in the adapter", async () => {
  const projectRoot = await fixtureDir("agent-relay-hooks-no-beadsdir-");
  await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
  for (const adapter of [{}, { beads: {} }, { beads: { requiredDir: "" } }]) {
    assert.deepEqual(await ensureSessionHooks({ projectRoot, adapter }), []);
  }
});
