#!/usr/bin/env node
"use strict";

// Zero-dependency syntax check: `node --check` every tracked (or new) .js file.

const { execFileSync, spawnSync } = require("node:child_process");

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.js"], {
  encoding: "utf-8",
})
  .split("\0")
  .filter(Boolean);

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf-8" });
  if (res.status !== 0) {
    failed++;
    process.stderr.write(res.stderr);
  }
}

if (failed > 0) {
  process.stderr.write(`${failed} file(s) failed the syntax check.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Syntax OK (${files.length} files).\n`);
}
