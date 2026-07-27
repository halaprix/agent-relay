#!/usr/bin/env node
import { parseCliArgs } from "../src/lib/cli.mjs";
import { doctor, setup, plan, run, resume, status, review, gates, cleanup, graph, view } from "../src/lib/supervisor.mjs";
import { printResult, result } from "../src/lib/output.mjs";

const parsed = parseCliArgs(process.argv.slice(2));
const projectRoot = process.cwd();

async function main() {
  const adapterName = parsed.options.adapter || "example-app";
  switch (parsed.command) {
    case "setup":
      return setup({ projectRoot, adapterName });
    case "doctor":
      return doctor({ projectRoot, adapterName });
    case "plan":
      return plan({ projectRoot, adapterName, beadId: parsed.positionals[0] });
    case "run":
      return run({ projectRoot, adapterName, beadId: parsed.positionals[0] });
    case "resume":
      return resume({ projectRoot, adapterName, beadId: parsed.positionals[0] });
    case "graph":
      return graph({
        projectRoot,
        adapterName,
        beadId: parsed.positionals[0] || null,
        outPath: typeof parsed.options.out === "string" ? parsed.options.out : null
      });
    case "view":
      return view({
        projectRoot,
        adapterName,
        beadId: parsed.positionals[0] || null,
        port: parsed.options.port ? Number(parsed.options.port) : null,
        open: parsed.options["no-open"] !== true
      });
    case "status":
      return status({ projectRoot, beadId: parsed.positionals[0] });
    case "review":
      return review({ projectRoot, adapterName, beadId: parsed.positionals[0] });
    case "gates":
      return gates({ projectRoot, adapterName, beadId: parsed.positionals[0], gateName: parsed.positionals[1] });
    case "cleanup":
      return cleanup({ projectRoot, adapterName, beadId: parsed.positionals[0] });
    case "sync-adapters":
      return (await import("../src/lib/adapter.mjs")).syncAdapters();
    default:
      return result("project-misconfigured", "relay", {
        error: `unknown command: ${parsed.command || "<none>"}`,
        usage: [
          "relay setup --adapter example-app",
          "relay doctor",
          "relay plan <bead-id>",
          "relay run <bead-id>",
          "relay resume <bead-id>",
          "relay status [bead-id]",
          "relay graph [bead-id] [--out path.html]",
          "relay view [bead-id] [--port n] [--no-open]",
          "relay review <bead-id>",
          "relay gates <bead-id> [gate-name]",
          "relay cleanup <bead-id>",
          "relay sync-adapters"
        ]
      });
  }
}

main()
  .then((payload) => {
    const normalized = payload?.exitClass ? payload : { ok: true, exitClass: "success", exitCode: 0, data: payload };
    printResult(normalized);
    process.exit(normalized.exitCode ?? 0);
  })
  .catch((error) => {
    printResult(
      result("unrecoverable-run-state", parsed.command || "relay", {
        error: error instanceof Error ? error.message : String(error)
      })
    );
    process.exit(13);
  });
