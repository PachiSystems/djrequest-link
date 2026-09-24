"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createFixtureDb, createInlineFixtureDb, cleanup } = require("./fixtures");
const { run } = require("../src/cli");

// Never touch the developer's real keychain from tests.
process.env.DJREQUEST_NO_KEYCHAIN = "1";

function captureStdout(fn) {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return output;
}

test("export command writes a valid, deterministic sync envelope", (t) => {
  const fx = createFixtureDb();
  t.after(() => cleanup(fx.dir));
  const out = path.join(fx.dir, "out.json");

  captureStdout(() =>
    run([
      "node",
      "cli",
      "catalogue",
      "export",
      "--db",
      fx.dbPath,
      "--playlist",
      "House/Deep",
      "--playlist",
      "Top 100",
      "--out",
      out,
    ])
  );

  const envelope = JSON.parse(fs.readFileSync(out, "utf-8"));
  assert.equal(envelope.source, "engine-dj");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.trackCount, 3);
  assert.deepEqual(
    envelope.tracks.map((tk) => tk.Id),
    [101, 102, 103]
  );
  assert.deepEqual(envelope.playlistPaths, ["House/Deep", "Top 100"]);
});

test("list-playlists command prints paths", (t) => {
  const fx = createFixtureDb();
  t.after(() => cleanup(fx.dir));

  const output = captureStdout(() =>
    run(["node", "cli", "catalogue", "list-playlists", "--db", fx.dbPath])
  );

  assert.match(output, /House\/Deep/);
  assert.match(output, /Top 100/);
});

test("export with an unknown playlist throws PLAYLIST_NOT_FOUND", (t) => {
  const fx = createFixtureDb();
  t.after(() => cleanup(fx.dir));
  const out = path.join(fx.dir, "out.json");

  assert.throws(
    () =>
      run(["node", "cli", "catalogue", "export", "--db", fx.dbPath, "--playlist", "Nope", "--out", out]),
    /Playlist not found/
  );
});

test("missing --db is a clear argument error", () => {
  assert.throws(() => run(["node", "cli", "catalogue", "list-playlists"]), /Missing required option --db/);
});

test("sync --dry-run prints a summary and makes no network calls or manifest", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));
  const manifestPath = path.join(fx.dir, "m.json");

  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    await run([
      "node",
      "cli",
      "catalogue",
      "sync",
      "--db",
      fx.dbPath,
      "--api-url",
      "https://app.example.com",
      "--api-key",
      "k",
      "--playlist",
      "All",
      "--manifest",
      manifestPath,
      "--dry-run",
    ]);
  } finally {
    process.stdout.write = original;
  }

  assert.match(output, /\[dry-run\]/);
  assert.match(output, /sha256:/);
  assert.equal(fs.existsSync(manifestPath), false);
});

test("sync --dry-run needs no API key", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));
  const saved = process.env.DJREQUEST_API_KEY;
  delete process.env.DJREQUEST_API_KEY;
  t.after(() => {
    if (saved !== undefined) process.env.DJREQUEST_API_KEY = saved;
  });

  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    await run([
      "node", "cli", "catalogue", "sync",
      "--db", fx.dbPath,
      "--playlist", "All",
      "--manifest", path.join(fx.dir, "m.json"),
      "--dry-run",
    ]);
  } finally {
    process.stdout.write = original;
  }
  assert.match(output, /\[dry-run\] 2 track/);
});

test("sync without a key (and not dry-run) explains where to set it", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));
  const saved = process.env.DJREQUEST_API_KEY;
  delete process.env.DJREQUEST_API_KEY;
  t.after(() => {
    if (saved !== undefined) process.env.DJREQUEST_API_KEY = saved;
  });

  await assert.rejects(
    run(["node", "cli", "catalogue", "sync", "--db", fx.dbPath, "--playlist", "All"]),
    /DJREQUEST_API_KEY/
  );
});

test("unknown commands are clear errors", () => {
  assert.throws(() => run(["node", "cli", "list-playlists"]), /Unknown command: list-playlists/);
  assert.throws(() => run(["node", "cli", "catalogue", "nope"]), /Unknown catalogue command: nope/);
});
