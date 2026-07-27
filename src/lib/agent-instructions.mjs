import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { pathExists } from "./fs.mjs";
import { repoPath } from "./paths.mjs";

// The canonical file plus the two assistants that need an importer. Codex and
// opencode read AGENTS.md natively, so they get no file of their own.
export const AGENT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

function templatePath(fileName) {
  return repoPath("templates", "agent-instructions", fileName);
}

// Instruction files are per-machine project law, not deliverables: they name local
// tooling and may quote paths. Keeping them out of the index is what makes it safe
// to write them without asking.
//
// Root-anchored on purpose. A bare `AGENTS.md` pattern matches at every depth, so it
// would also ignore a package-level AGENTS.md the project does track.
export function agentInstructionExcludeMarkers() {
  return AGENT_INSTRUCTION_FILES.map((fileName) => `/${fileName}`);
}

// Writes any missing instruction file from its shipped template. An existing file
// is never touched - it is the project's own law by then, and a template is only a
// starting point.
export async function scaffoldAgentInstructions(projectRoot) {
  const written = [];
  const preserved = [];
  for (const fileName of AGENT_INSTRUCTION_FILES) {
    const destination = path.join(projectRoot, fileName);
    if (await pathExists(destination)) {
      preserved.push(fileName);
      continue;
    }
    await writeFile(destination, await readFile(templatePath(fileName), "utf8"), "utf8");
    written.push(fileName);
  }
  return { written, preserved };
}

export async function agentInstructionStatus(projectRoot) {
  const present = [];
  const missing = [];
  for (const fileName of AGENT_INSTRUCTION_FILES) {
    (await pathExists(path.join(projectRoot, fileName)) ? present : missing).push(fileName);
  }
  return { present, missing };
}
