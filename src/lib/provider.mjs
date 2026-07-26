import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "./fs.mjs";
import { PROVIDERS } from "./providers/index.mjs";

export function classifyProviderFailure(runResult) {
  const stderr = `${runResult.stderr || ""} ${runResult.stdout || ""}`.toLowerCase();
  if (runResult.timedOut) {
    return "checkpoint-and-handoff";
  }
  if (/quota|rate limit|429|authentication|unauthorized|forbidden/.test(stderr)) {
    return "handoff-immediate";
  }
  if (/timed out|timeout|econnreset|service unavailable|network/.test(stderr)) {
    return "handoff-after-retry";
  }
  if (runResult.signal === "SIGTERM" || /crash|segmentation|missing report/.test(stderr)) {
    return "checkpoint-and-handoff";
  }
  return "return-to-coder";
}

export function parseWorkerReport(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("worker report missing stdout");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        continue;
      }
    }
    throw new Error("worker report was not valid JSON");
  }
}

export async function runProviderCommand({
  providerName,
  command,
  args = [],
  cwd,
  env = {},
  timeoutMs,
  inheritEnv = true,
  captureViaEnv = true
}) {
  const resolvedCommand = command.endsWith(".mjs") || command.endsWith(".js") ? process.execPath : command;
  const resolvedArgs =
    resolvedCommand === process.execPath && command !== process.execPath
      ? [command, ...args]
      : args;
  return withTempDir("agent-relay-capture-", (captureDir) => runProviderCommandInCaptureDir({
    providerName,
    resolvedCommand,
    resolvedArgs,
    cwd,
    env,
    timeoutMs,
    inheritEnv,
    captureViaEnv,
    captureDir
  }));
}

function runProviderCommandInCaptureDir({
  providerName,
  resolvedCommand,
  resolvedArgs,
  cwd,
  env,
  timeoutMs,
  inheritEnv,
  captureViaEnv,
  captureDir
}) {
  const stdoutPath = path.join(captureDir, "stdout.log");
  const stderrPath = path.join(captureDir, "stderr.log");
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd,
      env: {
        ...(inheritEnv ? process.env : {}),
        ...env,
        AGENT_RELAY_PROVIDER: providerName,
        ...(captureViaEnv
          ? {
              AGENT_RELAY_STDOUT_FILE: stdoutPath,
              AGENT_RELAY_STDERR_FILE: stderrPath
            }
          : {})
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const resolveResult = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      resolve(payload);
    };
    const killProcessGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      if (timedOut) {
        killProcessGroup("SIGKILL");
      }
    }, timeoutMs + 250);
    const finalTimer = setTimeout(() => {
      Promise.all([
        stdout ? Promise.resolve(stdout) : readFile(stdoutPath, "utf8").catch(() => ""),
        stderr ? Promise.resolve(stderr) : readFile(stderrPath, "utf8").catch(() => "")
      ]).then(([capturedStdout, capturedStderr]) =>
        resolveResult({
          providerName,
          code: 1,
          signal: "SIGKILL",
          stdout: capturedStdout,
          stderr: capturedStderr,
          timedOut
        })
      );
    }, timeoutMs + 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolveResult({
        providerName,
        code: 1,
        signal: null,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        timedOut
      });
    });
    child.on("close", (code, signal) => {
      Promise.all([
        stdout ? Promise.resolve(stdout) : readFile(stdoutPath, "utf8").catch(() => ""),
        stderr ? Promise.resolve(stderr) : readFile(stderrPath, "utf8").catch(() => "")
      ]).then(([capturedStdout, capturedStderr]) => {
        resolveResult({
          providerName,
          code: code ?? 1,
          signal,
          stdout: capturedStdout,
          stderr: capturedStderr,
          timedOut
        });
      });
    });
  });
}

export const SUPPORTED_PROVIDER_VENDORS = new Set(["anthropic", "openai", "google"]);

export function providerCommandFromConfig(config, providerName) {
  const provider = config.providers?.[providerName];
  return provider?.command ? provider : null;
}

function normalizeVendor(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const vendor = value.trim().toLowerCase();
  return SUPPORTED_PROVIDER_VENDORS.has(vendor) ? vendor : null;
}

// Vendor is a RESOLVED property, not a trusted declared string. A provider manifest may
// resolve the vendor its configured model actually points at (resolveVendor); the operator
// may also declare a vendor in providerConfig.vendor. When both are present they must agree
// — quorum counting depends on this, and a model-agnostic provider that declares one vendor
// while its configured model resolves to another must not be allowed to silently
// misrepresent itself as a distinct vendor for review-quorum purposes.
// A manifest implements resolveVendor only when vendor is genuinely DERIVABLE from
// config — that means a model-agnostic CLI whose configured model argument names the
// upstream. Fixed-vendor CLIs omit it: the config key is an operator-chosen label, not
// evidence of which binary runs, so treating the name as proof would just relocate the
// misdeclaration this function exists to catch. Their declared vendor stays authoritative.
export function providerVendor(providerName, providerConfig) {
  const declared = normalizeVendor(providerConfig?.vendor);
  const manifest = PROVIDERS.find((candidate) => candidate.name === providerName);
  const resolved = manifest?.resolveVendor ? normalizeVendor(manifest.resolveVendor(providerConfig)) : null;
  if (declared && resolved) {
    if (declared !== resolved) {
      throw new Error(`provider ${providerName} declares vendor ${declared} but its configured model resolves to ${resolved}`);
    }
    return declared;
  }
  if (declared) {
    return declared;
  }
  if (resolved) {
    return resolved;
  }
  return null;
}

export function providerStrength(providerConfig) {
  if (typeof providerConfig?.strength !== "string" || providerConfig.strength.trim() === "") {
    return null;
  }
  return providerConfig.strength.trim();
}

export function validateRuntimeProviderConfig(providerName, providerConfig, { requireReviewMetadata = false } = {}) {
  if (!providerConfig || typeof providerConfig !== "object") {
    throw new Error(`provider ${providerName} is misconfigured`);
  }
  if (typeof providerConfig.command !== "string" || providerConfig.command.trim() === "") {
    throw new Error(`provider ${providerName}.command must be a non-empty string`);
  }
  if (providerConfig.args !== undefined && (!Array.isArray(providerConfig.args) || providerConfig.args.some((arg) => typeof arg !== "string"))) {
    throw new Error(`provider ${providerName}.args must be a string array`);
  }
  if (providerConfig.env !== undefined && (providerConfig.env === null || typeof providerConfig.env !== "object" || Array.isArray(providerConfig.env))) {
    throw new Error(`provider ${providerName}.env must be an object`);
  }
  if (!providerVendor(providerName, providerConfig)) {
    throw new Error(`provider ${providerName}.vendor must be configured explicitly to one of ${[...SUPPORTED_PROVIDER_VENDORS].join(", ")}`);
  }
  if (providerConfig.runtime !== undefined) {
    if (providerConfig.runtime === null || typeof providerConfig.runtime !== "object" || Array.isArray(providerConfig.runtime)) {
      throw new Error(`provider ${providerName}.runtime must be an object`);
    }
    if (providerConfig.runtime.readOnlyMounts !== undefined) {
      if (!Array.isArray(providerConfig.runtime.readOnlyMounts) || providerConfig.runtime.readOnlyMounts.some((mountPath) => typeof mountPath !== "string" || !path.isAbsolute(mountPath))) {
        throw new Error(`provider ${providerName}.runtime.readOnlyMounts must be an array of absolute paths`);
      }
    }
  }
  if (requireReviewMetadata) {
    if (!providerStrength(providerConfig)) {
      throw new Error(`provider ${providerName}.strength must be configured explicitly for review`);
    }
  }
}
