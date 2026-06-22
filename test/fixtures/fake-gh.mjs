#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const storePath = process.env.FAKE_GH_STORE;
const stdoutFile = process.env.AGENT_RELAY_STDOUT_FILE;
const stderrFile = process.env.AGENT_RELAY_STDERR_FILE;
const store = JSON.parse(await readFile(storePath, "utf8"));
const args = process.argv.slice(2);

async function save() {
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function out(text) {
  if (stdoutFile) {
    await writeFile(stdoutFile, text, "utf8");
    return;
  }
  process.stdout.write(text);
}

async function err(text) {
  if (stderrFile) {
    await writeFile(stderrFile, text, "utf8");
    return;
  }
  process.stderr.write(text);
}

if (store.fail) {
  await err("gh failure\n");
  process.exit(1);
}

if (args[0] === "pr" && args[1] === "create") {
  const url = `https://relay.test/pr/${store.prs.length + 1}`;
  const bodyFileIndex = args.indexOf("--body-file");
  const titleIndex = args.indexOf("--title");
  store.prs.push({
    cwd: process.cwd(),
    args,
    url,
    title: titleIndex === -1 ? null : args[titleIndex + 1],
    body: bodyFileIndex === -1 ? null : await readFile(args[bodyFileIndex + 1], "utf8")
  });
  await save();
  await out(`creating pull request for ${process.cwd()}\n${url}\n`);
  process.exit(0);
}

await err(`unsupported fake gh command: ${args.join(" ")}\n`);
process.exit(1);
