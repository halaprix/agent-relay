#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";

const markerPath = process.env.PROVIDER_TIMEOUT_MARKER;

if (process.argv.includes("--child")) {
  process.on("SIGTERM", () => {});
  setInterval(async () => {
    await appendFile(markerPath, `${Date.now()}\n`, "utf8");
  }, 50);
} else {
  process.on("SIGTERM", () => {});
  await writeFile(markerPath, "", "utf8");
  spawn(process.execPath, [new URL(import.meta.url).pathname, "--child"], {
    stdio: "ignore"
  });
  setInterval(() => {}, 1000);
}
