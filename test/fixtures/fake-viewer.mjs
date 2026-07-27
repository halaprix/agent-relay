#!/usr/bin/env node
// Stands in for the real viewer: records how it was invoked so the launch contract can be
// asserted without a browser or a network fetch.
import { writeFileSync } from "node:fs";

writeFileSync(
  process.env.FAKE_VIEWER_REPORT,
  JSON.stringify({
    argv: process.argv.slice(2),
    beadsDir: process.env.BEADS_DIR ?? null,
    cwd: process.cwd()
  }),
  "utf8"
);
process.exit(Number(process.env.FAKE_VIEWER_EXIT ?? 0));
