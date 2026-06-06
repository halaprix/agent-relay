#!/usr/bin/env node
import { syncRoleBundles } from "../src/lib/roles.mjs";

const check = process.argv.includes("--check");
await syncRoleBundles({ check });
