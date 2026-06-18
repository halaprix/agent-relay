#!/usr/bin/env node
if (process.env.AGENT_RELAY_STDERR_FILE) {
  await import("node:fs/promises").then((fs) => fs.writeFile(process.env.AGENT_RELAY_STDERR_FILE, "quota exceeded\n", "utf8"));
} else {
  process.stderr.write("quota exceeded\n");
}
process.exit(1);
