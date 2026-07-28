#!/usr/bin/env node
import { parseCliArgs } from "../src/lib/cli.mjs";
import { doctor, setup, plan, run, resume, status, review, gates, cleanup, graph, view } from "../src/lib/supervisor.mjs";
import { printResult, result } from "../src/lib/output.mjs";

const parsed = parseCliArgs(process.argv.slice(2));
const projectRoot = process.cwd();

async function main() {
  // No default here, deliberately: a project that named neither --adapter nor
  // --adapter-file, and has no <projectRoot>/.agents/agent-relay/adapter.json, gets a
  // clear project-misconfigured error from resolveAdapter() - never a silent fallback to
  // the bundled example-app, which would run someone's real project under a stranger's
  // gates and control-plane paths without them choosing to.
  const adapterName = parsed.options.adapter || null;
  const adapterFile = parsed.options["adapter-file"] || null;
  switch (parsed.command) {
    case "setup":
      return setup({ projectRoot, adapterName, adapterFile });
    case "doctor":
      return doctor({ projectRoot, adapterName, adapterFile });
    case "plan":
      return plan({ projectRoot, adapterName, adapterFile, beadId: parsed.positionals[0] });
    case "run":
      return run({ projectRoot, adapterName, adapterFile, beadId: parsed.positionals[0] });
    case "resume":
      return resume({ projectRoot, adapterName, adapterFile, beadId: parsed.positionals[0] });
    case "graph":
      return graph({
        projectRoot,
        adapterName,
        adapterFile,
        beadId: parsed.positionals[0] || null,
        outPath: typeof parsed.options.out === "string" ? parsed.options.out : null
      });
    case "view":
      return view({
        projectRoot,
        adapterName,
        adapterFile,
        beadId: parsed.positionals[0] || null,
        port: parsed.options.port ? Number(parsed.options.port) : null,
        open: parsed.options["no-open"] !== true
      });
    case "status":
      return status({ projectRoot, beadId: parsed.positionals[0] });
    case "review":
      return review({ projectRoot, adapterName, adapterFile, beadId: parsed.positionals[0] });
    case "gates":
      return gates({ projectRoot, adapterName, adapterFile, beadId: parsed.positionals[0], gateName: parsed.positionals[1] });
    case "cleanup":
      return cleanup({ projectRoot, adapterName, adapterFile, beadId: parsed.positionals[0] });
    case "sync-adapters":
      return (await import("../src/lib/adapter.mjs")).syncAdapters();
    default:
      return result("project-misconfigured", "relay", {
        error: `unknown command: ${parsed.command || "<none>"}`,
        usage: [
          "relay setup [--adapter <bundled-name> | --adapter-file <path>]",
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
          "relay sync-adapters",
          "",
          "Every command accepts --adapter <bundled-name> or --adapter-file <path>.",
          "Without either, a project adapter at .agents/agent-relay/adapter.json is used",
          "if one exists; otherwise this is a clear error, not a silent default."
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
