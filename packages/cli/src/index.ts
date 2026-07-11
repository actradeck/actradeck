#!/usr/bin/env node
// Bin entry for `actradeck`. Thin wrapper: build the real Deps (the only place real IO is
// wired), route argv, and exit with the command's code. All logic + branch coverage lives in
// cli.ts and the command modules over an injectable Deps — this file is intentionally trivial
// and excluded from the coverage gate (it cannot be exercised without real IO / process.exit).
import { makeRealDeps } from "./lib/deps.js";
import { run } from "./cli.js";

const deps = await makeRealDeps();
const code = await run(deps, process.argv.slice(2));
process.exit(code);
