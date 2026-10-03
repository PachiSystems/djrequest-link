#!/usr/bin/env node
"use strict";

// Node 22.15+ is required (Node 22 is the newest line that still runs on
// macOS 11). Say so plainly instead of failing with a syntax/API error.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 15)) {
  process.stderr.write(
    `djrequest-link needs Node.js 22.15 or newer; this is ${process.version}. ` +
      "Download it from https://nodejs.org/\n"
  );
  process.exit(1);
}

// node:sqlite prints an ExperimentalWarning on every run. It is noise for end
// users (the API is stable enough for our read-only use), so replace Node's
// default warning printer with one that drops that single warning and prints
// every other warning as before.
const defaultWarningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  for (const listener of defaultWarningListeners) listener(warning);
});

const { main } = require("../src/cli");

main(process.argv).catch((err) => {
  // Message only — no stack trace. Stacks carry local file paths.
  process.stderr.write(`Unexpected error: ${err && err.message ? err.message : err}\n`);
  if (process.env.DJREQUEST_DEBUG) process.stderr.write(`${err && err.stack}\n`);
  process.exitCode = 1;
});
