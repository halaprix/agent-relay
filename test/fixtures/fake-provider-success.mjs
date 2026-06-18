#!/usr/bin/env node
const report = process.env.FAKE_PROVIDER_REPORT
  ? JSON.parse(process.env.FAKE_PROVIDER_REPORT)
  : {
      status: "success",
      summary: "implemented scope",
      ownedPaths: ["src", "README.md"],
      commandsAttempted: ["node test-command.js"],
      changedPaths: ["src/index.ts"],
      gatesClaimed: ["types-and-tests"],
      artifacts: []
    };

const output = `${JSON.stringify(report)}\n`;
if (process.env.AGENT_RELAY_STDOUT_FILE) {
  await import("node:fs/promises").then((fs) => fs.writeFile(process.env.AGENT_RELAY_STDOUT_FILE, output, "utf8"));
} else {
  process.stdout.write(output);
}
