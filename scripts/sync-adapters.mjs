#!/usr/bin/env node
import { syncAdapters } from "../src/lib/adapter.mjs";

const check = process.argv.includes("--check");
await syncAdapters({ check });
