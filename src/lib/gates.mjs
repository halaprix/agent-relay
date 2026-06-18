import path from "node:path";
import { runProviderCommand } from "./provider.mjs";

export async function runGateGroup({ adapter, projectRoot, gateName, env = {} }) {
  const groups = adapter.gates.groups;
  const selected = gateName ? { [gateName]: groups[gateName] } : groups;
  if (gateName && !selected[gateName]) {
    throw new Error(`unknown gate group: ${gateName}`);
  }
  const results = [];
  for (const [group, gates] of Object.entries(selected)) {
    for (const gate of gates) {
      if (gate.humanOnly) {
        results.push({
          group,
          gate: gate.name,
          status: "human-action-required",
          reason: gate.reason
        });
        continue;
      }
      const [command, ...args] = gate.command;
      const run = await runProviderCommand({
        providerName: `gate:${group}:${gate.name}`,
        command,
        args,
        cwd: gate.cwd ? path.join(projectRoot, gate.cwd) : projectRoot,
        env,
        timeoutMs: 30 * 60 * 1000
      });
      results.push({
        group,
        gate: gate.name,
        status: run.code === 0 ? "passed" : "failed",
        code: run.code,
        stdout: run.stdout,
        stderr: run.stderr
      });
    }
  }
  return results;
}
