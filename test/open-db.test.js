"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { openDatabase, WAL_WARNING } = require("../src/catalogue/open-db");

function makeWalDb(dirName = "wal-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), dirName));
  const dbPath = path.join(dir, "m.db");
  const w = new DatabaseSync(dbPath);
  w.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);");
  w.close(); // checkpoints and removes -wal/-shm
  return { dir, dbPath };
}

test("opening a WAL-mode library creates no -wal/-shm sidecar files", (t) => {
  const { dir, dbPath } = makeWalDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(fs.readdirSync(dir), ["m.db"]);

  const db = openDatabase(dbPath);
  assert.equal(db.prepare("SELECT count(*) AS c FROM t").get().c, 1);
  assert.deepEqual(fs.readdirSync(dir), ["m.db"], "no sidecars while open");
  db.close();
  assert.deepEqual(fs.readdirSync(dir), ["m.db"], "no sidecars after close");
});

test("the connection rejects writes", (t) => {
  const { dir, dbPath } = makeWalDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(dbPath);
  try {
    assert.throws(() => db.exec("INSERT INTO t VALUES (2)"));
    assert.throws(() => db.exec("CREATE TABLE evil (y)"));
  } finally {
    db.close();
  }
});

test("paths with spaces, # and % open correctly", (t) => {
  const { dir, dbPath } = makeWalDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const odd = path.join(dir, "Engine Library #2 100%");
  fs.mkdirSync(odd);
  const oddDb = path.join(odd, "m.db");
  fs.copyFileSync(dbPath, oddDb);

  const db = openDatabase(oddDb);
  assert.equal(db.prepare("SELECT count(*) AS c FROM t").get().c, 1);
  db.close();
  assert.deepEqual(fs.readdirSync(odd), ["m.db"]);
});

test("warns when Engine DJ has unsaved changes in m.db-wal", (t) => {
  const { dir, dbPath } = makeWalDb();
  // Simulate a running Engine DJ: an open writer with a committed-but-not-
  // checkpointed transaction leaves a non-empty m.db-wal.
  const writer = new DatabaseSync(dbPath);
  writer.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO t VALUES (2);");
  t.after(() => {
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const db = openDatabase(dbPath);
  try {
    assert.deepEqual(db.warnings, [WAL_WARNING]);
  } finally {
    db.close();
  }
});

test("no warning for a cleanly closed library", (t) => {
  const { dir, dbPath } = makeWalDb();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(dbPath);
  assert.deepEqual(db.warnings, []);
  db.close();
});

test("missing file and directory give clear errors", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => openDatabase(path.join(dir, "nope.db")), /not found/);
  assert.throws(() => openDatabase(dir), /directory/);
});
