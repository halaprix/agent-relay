#!/usr/bin/env node
if (process.env.AGENT_RELAY_STDOUT_FILE) {
  await import("node:fs/promises").then((fs) => fs.writeFile(process.env.AGENT_RELAY_STDOUT_FILE, "not json\n", "utf8"));
} else {
  process.stdout.write("not json\n");
}
