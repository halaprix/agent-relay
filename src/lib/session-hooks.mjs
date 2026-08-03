import path from "node:path";
import { pathExists, readJson, writeJson } from "./fs.mjs";
import { PROVIDERS } from "./providers/index.mjs";

// A session-start hook is the one piece of project wiring that model-readable guidance
// cannot cover: it fires before the assistant reads a single instruction file. `bd init`
// writes a bare `bd prime --hook-json`, and on a machine that exports a global BEADS_DIR
// pointing at another project, that bare command primes the WRONG store on every session
// start - silently, and with no opportunity for AGENTS.md to intervene.
//
// The fix is a per-invocation prefix scoped to this project's own root, which is the exact
// inverse of the hazard the agent-instruction template warns about: a global export leaks
// one project's store into every other project, while this pins one command to this
// project and makes an inherited global export irrelevant.
//
// Which file to write and which variable names the harness's project root is provider
// behaviour, so both come from the provider manifest (`sessionHook`). A provider whose
// hook format is not known simply omits the descriptor and is skipped - the same shape as
// `resolveVendor` on a fixed-vendor manifest.

export const PRIME_COMMAND = "bd prime --hook-json";

// Matches any hook already priming Beads, scoped or not, so an existing entry is upgraded
// in place instead of being duplicated alongside a second, conflicting one.
function isPrimeHook(entry) {
  return Boolean(
    entry &&
      entry.type === "command" &&
      typeof entry.command === "string" &&
      entry.command.includes("bd prime")
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildPrimeCommand({ projectDirVar, requiredDir }) {
  // An absolute requiredDir is already unambiguous; interpolating the harness's project
  // root in front of it would produce a path that does not exist.
  const target = path.isAbsolute(requiredDir) ? requiredDir : `$${projectDirVar}/${requiredDir}`;
  return `BEADS_DIR="${target}" ${PRIME_COMMAND}`;
}

// Pure merge. Returns the settings object to write plus what it did, so the caller can
// report honestly rather than claiming it configured something that was already correct.
export function mergeSessionHook(settings, { event, command }) {
  const next = isPlainObject(settings) ? { ...settings } : {};
  const hooks = isPlainObject(next.hooks) ? { ...next.hooks } : {};
  const matchers = Array.isArray(hooks[event]) ? hooks[event].map((matcher) => ({ ...matcher })) : [];

  let upgraded = 0;
  let alreadyScoped = 0;
  for (const matcher of matchers) {
    if (!Array.isArray(matcher.hooks)) {
      continue;
    }
    matcher.hooks = matcher.hooks.map((entry) => {
      if (!isPrimeHook(entry)) {
        return entry;
      }
      // An entry that already scopes BEADS_DIR is left exactly as written: it may be a
      // deliberate local variant, and overwriting a working hook is not this function's
      // job.
      if (entry.command.includes("BEADS_DIR")) {
        alreadyScoped += 1;
        return entry;
      }
      upgraded += 1;
      return { ...entry, command };
    });
  }

  if (upgraded === 0 && alreadyScoped === 0) {
    matchers.push({ matcher: "", hooks: [{ type: "command", command }] });
  }

  hooks[event] = matchers;
  next.hooks = hooks;
  return {
    settings: next,
    action: upgraded > 0 ? "upgraded" : alreadyScoped > 0 ? "unchanged" : "added"
  };
}

// Writes the hook for every provider that declares one and is actually set up in this
// project. The presence test is the provider's own top-level directory - the same signal
// syncProjectRoles uses - so a project that does not use a provider never gains its
// configuration file.
export async function ensureSessionHooks({ projectRoot, adapter }) {
  const requiredDir = adapter?.beads?.requiredDir;
  if (typeof requiredDir !== "string" || requiredDir === "") {
    return [];
  }
  const records = [];
  for (const provider of PROVIDERS) {
    const descriptor = provider.sessionHook;
    if (!descriptor) {
      continue;
    }
    const settingsPath = path.join(projectRoot, ...descriptor.settingsPath);
    if (!(await pathExists(path.dirname(settingsPath)))) {
      continue;
    }

    let existing = {};
    if (await pathExists(settingsPath)) {
      try {
        existing = await readJson(settingsPath);
      } catch (error) {
        // Reported, never overwritten: clobbering a file we cannot parse would destroy
        // whatever the human actually had in it.
        records.push({
          provider: provider.name,
          path: settingsPath,
          action: "skipped",
          error: `could not parse ${settingsPath}: ${error.message}`
        });
        continue;
      }
    }

    const command = buildPrimeCommand({ projectDirVar: descriptor.projectDirVar, requiredDir });
    const { settings, action } = mergeSessionHook(existing, { event: descriptor.event, command });
    if (action !== "unchanged") {
      await writeJson(settingsPath, settings);
    }
    records.push({ provider: provider.name, path: settingsPath, action, command });
  }
  return records;
}
