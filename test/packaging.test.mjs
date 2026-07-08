import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { lstat, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { repoPath } from "../src/lib/paths.mjs";
import { validateMarketplaceFile } from "../scripts/validate-marketplaces.mjs";

test("dev install links an executable relay entrypoint", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-relay-home-"));
  const install = spawnSync(repoPath("scripts", "dev-install.sh"), {
    cwd: repoPath(),
    env: { ...process.env, HOME: home },
    encoding: "utf8"
  });
  assert.equal(install.status, 0, install.stderr);
  const relayPath = path.join(home, ".local", "bin", "relay");
  const relayStat = await lstat(relayPath);
  assert.equal(relayStat.isSymbolicLink(), true);
  const run = spawnSync(relayPath, ["--json"], {
    cwd: repoPath(),
    encoding: "utf8"
  });
  assert.equal(run.status, 12);
});

test("Claude hook entrypoints execute directly", () => {
  const hook = spawnSync(repoPath(".claude-plugin", "hooks", "pretooluse.mjs"), {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        cmd: "echo ok"
      }
    }),
    encoding: "utf8"
  });
  assert.equal(hook.status, 0, hook.stderr);
});

test("marketplace entries resolve to the packaged plugin target", async () => {
  const codex = await validateMarketplaceFile(repoPath(".codex-plugin", "marketplace.json"));
  const claude = await validateMarketplaceFile(repoPath(".claude-plugin", "marketplace.json"));
  assert.equal(codex[0].target, repoPath("plugins", "agent-relay"));
  assert.equal(claude[0].target, repoPath("plugins", "agent-relay"));
});

test("marketplace validator rejects missing plugin targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-marketplace-"));
  const pluginRoot = path.join(root, "plugins");
  await mkdir(pluginRoot, { recursive: true });
  await symlink(repoPath(), path.join(pluginRoot, "agent-relay"));
  const marketplacePath = path.join(root, "marketplace.json");
  await writeFile(
    marketplacePath,
    `${JSON.stringify({
      name: "agent-relay-local",
      plugins: [
        {
          name: "missing-plugin",
          source: {
            source: "local",
            path: "../plugins/missing-plugin"
          }
        }
      ]
    }, null, 2)}\n`,
    "utf8"
  );
  await assert.rejects(() => validateMarketplaceFile(marketplacePath), /must resolve to|missing marketplace plugin target/);
});
