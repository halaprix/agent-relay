#!/usr/bin/env node
import path from "node:path";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

const storePath = process.env.FAKE_GIT_STORE;
const stdoutFile = process.env.AGENT_RELAY_STDOUT_FILE;
const stderrFile = process.env.AGENT_RELAY_STDERR_FILE;
const store = JSON.parse(await readFile(storePath, "utf8"));
const rawArgs = process.argv.slice(2);
const args = [];
for (let index = 0; index < rawArgs.length; index += 1) {
  if (rawArgs[index] === "-c") {
    index += 1;
    continue;
  }
  args.push(rawArgs[index]);
}

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

store.records.commands.push({ cwd: process.cwd(), args });

if (args[0] === "status") {
  const value = process.cwd() === store.projectRoot
    ? (store.mainStatusQueue.shift() ?? "")
    : (store.worktrees[process.cwd()]?.statusQueue?.shift() ?? store.worktrees[process.cwd()]?.status ?? "");
  await save();
  await out(`${value}\n`);
  process.exit(0);
}

if (args[0] === "remote" && args[1] === "-v") {
  await out(`${store.remotes || ""}\n`);
  process.exit(0);
}

if (args[0] === "rev-parse" && args[1] === "HEAD") {
  const head = process.cwd() === store.projectRoot
    ? (store.mainHead || store.baseSha)
    : (store.worktrees[process.cwd()]?.head || store.baseSha);
  await out(`${head}\n`);
  process.exit(0);
}

if (args[0] === "rev-parse") {
  await out(`${store.baseSha}\n`);
  process.exit(0);
}

if (args[0] === "symbolic-ref" && args[1] === "--short" && args[2] === "HEAD") {
  const branch = process.cwd() === store.projectRoot
    ? (store.mainBranch || "dev")
    : (store.worktrees[process.cwd()]?.branch || "detached");
  await out(`${branch}\n`);
  process.exit(0);
}

if (args[0] === "worktree" && args[1] === "add") {
  const worktreePath = args[3];
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  for (const entry of await readdir(store.projectRoot, { withFileTypes: true })) {
    if (entry.name === ".agents") {
      continue;
    }
    await cp(path.join(store.projectRoot, entry.name), path.join(worktreePath, entry.name), { recursive: true });
  }
  store.worktrees[worktreePath] = {
    branch: null,
    head: store.baseSha,
    index: {},
    staged: [],
    commits: [],
    pushes: [],
    status: "",
    statusQueue: []
  };
  await save();
  process.exit(0);
}

if (args[0] === "checkout" && args[1] === "-b") {
  if (!store.worktrees[process.cwd()]) {
    store.worktrees[process.cwd()] = { branch: null, index: {}, staged: [], commits: [], pushes: [], statusQueue: [] };
  }
  store.worktrees[process.cwd()].branch = args[2];
  await save();
  process.exit(0);
}

if (args[0] === "add") {
  const paths = args.slice(args.indexOf("--") + 1);
  const worktree = store.worktrees[process.cwd()];
  worktree.index ||= {};
  for (const relativePath of paths) {
    worktree.index[relativePath] = await readFile(path.join(process.cwd(), relativePath), "utf8");
  }
  store.records.staged.push({ cwd: process.cwd(), paths });
  if (store.postAddMutation) {
    await writeFile(path.join(process.cwd(), store.postAddMutation.path), store.postAddMutation.content, "utf8");
  }
  await save();
  process.exit(0);
}

if (args[0] === "show" && typeof args[1] === "string" && args[1].startsWith(":")) {
  const worktree = store.worktrees[process.cwd()];
  const relativePath = args[1].slice(1);
  const content = worktree?.index?.[relativePath];
  if (content === undefined) {
    await err(`missing staged path ${relativePath}\n`);
    process.exit(1);
  }
  await out(content);
  process.exit(0);
}

if (args[0] === "commit") {
  store.records.commits.push({ cwd: process.cwd(), args });
  if (store.worktrees[process.cwd()]) {
    store.worktrees[process.cwd()].head = `commit-${store.records.commits.length}`;
    store.worktrees[process.cwd()].status = "";
  }
  await save();
  await out("[fake-commit]\n");
  process.exit(0);
}

if (args[0] === "push") {
  store.records.pushes.push({ cwd: process.cwd(), args });
  await save();
  await out("[fake-push]\n");
  process.exit(0);
}

if (args[0] === "worktree" && args[1] === "remove") {
  const worktreePath = args[2];
  store.records.removals.push({ cwd: process.cwd(), worktreePath });
  delete store.worktrees[worktreePath];
  await rm(worktreePath, { recursive: true, force: true });
  await save();
  process.exit(0);
}

if (args[0] === "worktree" && args[1] === "prune") {
  store.records.prunes.push({ cwd: process.cwd() });
  await save();
  process.exit(0);
}

await err(`unsupported fake git command: ${args.join(" ")}\n`);
process.exit(1);
