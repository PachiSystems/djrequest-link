"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { LinkError } = require("../errors");

// node:sqlite is loaded lazily, only when a catalogue command opens a library,
// so the rest of the tool (Now Playing, auth, venues) runs even on a Node
// build where it is unavailable.
function loadSqlite() {
  try {
    return require("node:sqlite");
  } catch {
    throw new LinkError(
      `Reading the Engine DJ library needs Node.js 22.15 or newer (this is ${process.version}).`,
      "NO_SQLITE_DRIVER"
    );
  }
}

// Node's built-in node:sqlite (Node >=22.15) is a statement-based native driver
// that does NOT load the whole database into memory, so a 1GB+ m.db is fine.
// Using it (rather than a native npm module) keeps the tool dependency-free and
// packageable as a single executable.
//
// The database is opened as an SQLite URI with `mode=ro&immutable=1`. A plain
// read-only open is NOT enough: on a WAL-mode database it still creates
// `m.db-wal` / `m.db-shm` next to the DJ's library and leaves them behind.
// `immutable=1` tells SQLite the file cannot change, so it takes no locks and
// creates no sidecar files at all. The cost is that it ignores pending changes
// a running Engine DJ has not finished writing — a non-empty `m.db-wal` (WAL
// mode) or `m.db-journal` (rollback-journal mode; Engine leaves an EMPTY one
// behind normally, which is fine). We detect those and warn.

const WAL_WARNING =
  "Engine DJ appears to be running (or did not shut down cleanly): its m.db-wal " +
  "file has unsaved changes that this tool cannot see. Close Engine DJ and run " +
  "again to include your latest library changes.";

const JOURNAL_WARNING =
  "Engine DJ appears to be writing to the library right now (its m.db-journal " +
  "file is not empty), so this snapshot may be incomplete. Close Engine DJ and " +
  "run again.";

/**
 * Open an Engine DJ database strictly read-only, without creating any files.
 * @param {string} dbPath absolute or relative path to m.db
 * @returns {DatabaseSync & { driver: string, warnings: string[] }}
 */
function openDatabase(dbPath) {
  if (!dbPath || typeof dbPath !== "string") {
    throw new LinkError("A database path is required (--db <path>).", "BAD_ARGS");
  }
  if (!fs.existsSync(dbPath)) {
    throw new LinkError(`Engine DJ database not found at: ${dbPath}`, "DB_NOT_FOUND");
  }
  if (fs.statSync(dbPath).isDirectory()) {
    throw new LinkError(`Expected an m.db file but got a directory: ${dbPath}`, "DB_NOT_FOUND");
  }

  const url = pathToFileURL(path.resolve(dbPath));
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");

  const { DatabaseSync } = loadSqlite();
  let db;
  try {
    db = new DatabaseSync(url, { readOnly: true });
  } catch (err) {
    throw new LinkError(
      `Could not open the Engine DJ database read-only: ${err.message}`,
      "DB_OPEN_FAILED"
    );
  }
  enforceReadOnly(db);
  db.driver = "node:sqlite";
  db.warnings = [];
  if (nonEmpty(`${dbPath}-wal`)) db.warnings.push(WAL_WARNING);
  if (nonEmpty(`${dbPath}-journal`)) db.warnings.push(JOURNAL_WARNING);
  return db;
}

function nonEmpty(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

// Defense in depth: the connection is already read-only, but ask SQLite to
// reject writes at the engine level too. Best-effort — never fatal.
function enforceReadOnly(db) {
  try {
    db.exec("PRAGMA query_only = ON");
  } catch {
    /* ignore — the read-only connection is the real guarantee */
  }
}

module.exports = { openDatabase, WAL_WARNING, JOURNAL_WARNING };
