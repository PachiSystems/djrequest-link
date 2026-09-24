#!/usr/bin/env node
"use strict";

/**
 * Repo hygiene guard for a PUBLIC repository. Fails (exit 1) if any tracked
 * file looks like something that must never be published:
 *
 *   - Engine DJ / SQLite databases and their sidecars
 *   - catalogue exports / sync manifests (contain library contents)
 *   - unexpectedly large files (a library export is easily megabytes)
 *   - real API keys (the app issues UUIDv4 keys; obvious placeholders such as
 *     11111111-1111-4111-8111-111111111111 are allowed)
 *   - absolute paths from a real machine (usernames, drive layout)
 *
 * Zero dependencies; runs in CI and can be run locally: `npm run check`.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const MAX_BYTES = 256 * 1024;

const FORBIDDEN_NAME = [
  /\.(db|db-wal|db-shm|db-journal|sqlite3?)$/i,
  /\.manifest\.json$/i,
  /catalogue.*\.json$/i,
  /\.envelope\.json$/i,
  /(^|\/)enginedj[^/]*\.json$/i,
  /(^|\/)\.env(\.|$)/i,
];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

const REAL_PATH = [
  // Windows: C:\Users\<name>, D:/Music Collection, etc. Allows %USERPROFILE%.
  /\b[A-Z]:[\\/]+(Users|Documents and Settings|Music)[\\/]+(?!<)[^\s"'`\\/]+/i,
  // Any folder on a non-system drive, including names with spaces
  // ("D:/Music Collection/...").
  /\b[D-Z]:[\\/]+[^"'`\\/<\r\n]+[\\/]/,
  // macOS / Linux home directories with a concrete username.
  /\/(Users|home)\/(?!(me|you|user|username|name|runner|<[^>]*>|\$USER)\/)[A-Za-z0-9._-]+\//,
];

// Zero-width, line/paragraph-separator and bidi-control characters: they can
// make reviewed source differ from what runs ("Trojan Source", CVE-2021-42574).
// Built from code points so this file stays ASCII.
const INVISIBLE = new RegExp(
  `[${[[0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
    .join("")}]`
);

// Files that legitimately describe these patterns.
const CONTENT_ALLOWLIST = new Set(["scripts/check-repo.js", ".gitignore"]);

function isPlaceholderUuid(u) {
  // Placeholders repeat one character per group, e.g. 1111…-4111-8111-1111….
  return u.split("-").every((g) => new Set(g.slice(1)).size === 1);
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf-8" });
  return out.split("\0").filter(Boolean);
}

function main() {
  const problems = [];

  for (const file of trackedFiles()) {
    if (FORBIDDEN_NAME.some((re) => re.test(file))) {
      problems.push(`${file}: forbidden file type for a public repo`);
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // deleted in the working tree
    }
    if (stat.size > MAX_BYTES) {
      problems.push(`${file}: ${stat.size} bytes exceeds ${MAX_BYTES} (library export?)`);
      continue;
    }
    if (CONTENT_ALLOWLIST.has(file)) continue;

    const text = fs.readFileSync(file, "utf-8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (INVISIBLE.test(line)) {
        problems.push(`${file}:${i + 1}: invisible or bidi-control character (Trojan Source risk)`);
      }
      for (const u of line.match(UUID) || []) {
        if (!isPlaceholderUuid(u)) {
          problems.push(`${file}:${i + 1}: UUID that may be a real API key`);
        }
      }
      if (REAL_PATH.some((re) => re.test(line))) {
        problems.push(`${file}:${i + 1}: absolute path that may come from a real machine`);
      }
    });
  }

  if (problems.length > 0) {
    process.stderr.write(`Repo hygiene check failed:\n  ${problems.join("\n  ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Repo hygiene check passed.\n");
}

main();
