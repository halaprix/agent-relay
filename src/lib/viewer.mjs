import { spawn } from "node:child_process";

// The interactive companion to `relay graph`. `relay graph` writes a self-contained page
// you can attach to a PR; this hands the same store to a viewer you can edit in.
//
// It is launched as an external tool, never imported. Agent Relay is pure ESM with zero
// runtime dependencies and the viewer ships a React bundle, so making it a dependency
// would break the constraint that lets `relay` run anywhere Node does. If it is not
// installed, npx fetches it; if there is no network, the failure says so plainly.
const DEFAULT_PACKAGE = "@halaprix/beads-viewer";

export function resolveViewerCommand(env = process.env) {
  // Overridable for tests and for anyone running a local checkout of the viewer,
  // matching how AGENT_RELAY_BD_BIN works for bd.
  const configured = env.AGENT_RELAY_VIEWER_BIN;
  if (configured) {
    return configured.endsWith(".mjs") || configured.endsWith(".js")
      ? { command: process.execPath, args: [configured] }
      : { command: configured, args: [] };
  }
  const packageSpec = env.AGENT_RELAY_VIEWER_PACKAGE || DEFAULT_PACKAGE;
  // -y so a first run does not stop on an install prompt nobody is watching.
  return { command: "npx", args: ["-y", packageSpec] };
}

export function buildViewerArgs({ beadId = null, port = null, open = true } = {}) {
  const args = [];
  if (beadId) {
    args.push("--bead", beadId);
  }
  if (port) {
    args.push("--port", String(port));
  }
  if (!open) {
    args.push("--no-open");
  }
  return args;
}

// The store is passed explicitly rather than inherited. An exported BEADS_DIR pointing at
// another project silently wins over repository discovery, so leaving it to chance is how
// the viewer ends up editing the wrong issue database.
export function buildViewerEnv({ beadsDir, env = process.env }) {
  return { ...env, BEADS_DIR: beadsDir };
}

export function launchViewer({ beadsDir, cwd, beadId = null, port = null, open = true, env = process.env }) {
  const { command, args } = resolveViewerCommand(env);
  const argv = [...args, ...buildViewerArgs({ beadId, port, open })];
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd,
      env: buildViewerEnv({ beadsDir, env }),
      // Inherited: the viewer prints a URL carrying a one-time token that the human needs
      // to see, and it stays in the foreground until they stop it.
      stdio: "inherit",
      shell: false
    });
    child.on("error", (error) =>
      resolve({
        code: 1,
        error:
          error.code === "ENOENT"
            ? `could not run \`${command}\`: install Node's npx, or set AGENT_RELAY_VIEWER_BIN to a local viewer`
            : error.message
      })
    );
    child.on("close", (code) => resolve({ code: code ?? 0, error: null }));
  });
}
