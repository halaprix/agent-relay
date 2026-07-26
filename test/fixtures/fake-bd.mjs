#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const storePath = process.env.FAKE_BD_STORE;
const store = JSON.parse(readFileSync(storePath, "utf8"));
const [, , command, ...args] = process.argv;
const stdoutFile = process.env.AGENT_RELAY_STDOUT_FILE;
const stderrFile = process.env.AGENT_RELAY_STDERR_FILE;

// Record the capture dir handed to us so the leak test can assert on that exact
// path instead of counting a shared, non-discriminating tmpdir prefix.
if (process.env.FAKE_BD_CAPTURE_REPORT && stdoutFile) {
  const report = process.env.FAKE_BD_CAPTURE_REPORT;
  const seen = (() => {
    try {
      return JSON.parse(readFileSync(report, "utf8"));
    } catch {
      return [];
    }
  })();
  seen.push(path.dirname(stdoutFile));
  writeFileSync(report, JSON.stringify(seen), "utf8");
}

function out(text) {
  if (stdoutFile) {
    writeFileSync(stdoutFile, text, "utf8");
    return;
  }
  process.stdout.write(text);
}

function err(text) {
  if (stderrFile) {
    writeFileSync(stderrFile, text, "utf8");
    return;
  }
  process.stderr.write(text);
}

function save() {
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

if (command === "where") {
  out(`${store.path}\n${(store.whereDetails || []).join("\n")}\n`);
  process.exit(0);
}

if (command === "prime") {
  out(`${store.primeOutput}\n`);
  process.exit(0);
}

if (command === "list" && args[0] === "--parent") {
  out(`${JSON.stringify((store.children || {})[args[1]] || [])}\n`);
  process.exit(0);
}

if (command === "memories" && args[0] === "--json") {
  out(`${JSON.stringify(store.memories)}\n`);
  process.exit(0);
}

if (command === "show" && args[1] === "--json") {
  const bead = store.issues[args[0]];
  if (!bead) {
    err("missing issue\n");
    process.exit(1);
  }
  out(`${JSON.stringify([bead])}\n`);
  process.exit(0);
}

if (command === "comments" && args[1] === "--json") {
  const bead = store.issues[args[0]];
  if (!bead) {
    err("missing issue\n");
    process.exit(1);
  }
  out(`${JSON.stringify(store.comments?.[args[0]] || [])}\n`);
  process.exit(0);
}

if (command === "update" && args[1] === "--claim" && args[2] === "--json") {
  const bead = store.issues[args[0]];
  if (!bead) {
    err("missing issue\n");
    process.exit(1);
  }
  if (bead.claimed || bead.claimConflict) {
    err("already claimed\n");
    process.exit(1);
  }
  bead.claimed = true;
  save();
  out(`${JSON.stringify([bead])}\n`);
  process.exit(0);
}

if (command === "comments" && args[0] === "add") {
  const beadId = args[1];
  const bead = store.issues[beadId];
  if (!bead) {
    err("missing issue\n");
    process.exit(1);
  }
  store.comments ||= {};
  store.comments[beadId] ||= [];
  const comment = {
    at: new Date().toISOString(),
    text: args[2]
  };
  store.comments[beadId].push(comment);
  save();
  out(`${JSON.stringify([comment])}\n`);
  process.exit(0);
}

err(`unsupported fake bd command: ${process.argv.slice(2).join(" ")}\n`);
process.exit(1);
