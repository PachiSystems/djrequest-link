"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFixtureDb, createInlineFixtureDb, cleanup } = require("./fixtures");
const { openDatabase } = require("../src/catalogue/open-db");
const {
  discoverSchema,
  listPlaylists,
  resolvePlaylist,
  exportPlaylists,
  rawInspect,
} = require("../src/catalogue/engine-library");

let fixture;

test.before(() => {
  fixture = createFixtureDb();
});

test.after(() => {
  if (fixture) cleanup(fixture.dir);
});

function withDb(fn) {
  const db = openDatabase(fixture.dbPath);
  try {
    return fn(db, discoverSchema(db));
  } finally {
    db.close();
  }
}

test("listPlaylists returns hierarchical paths and track counts", () => {
  const playlists = withDb((db, schema) => listPlaylists(db, schema));
  assert.deepEqual(
    playlists.map((p) => p.path),
    ["House", "House/Deep", "Top 100"]
  );
  const byPath = Object.fromEntries(playlists.map((p) => [p.path, p.trackCount]));
  assert.equal(byPath["House"], 0);
  assert.equal(byPath["House/Deep"], 2);
  assert.equal(byPath["Top 100"], 2);
});

test("resolvePlaylist accepts id, full path, or unique title", () => {
  withDb((db, schema) => {
    assert.equal(resolvePlaylist(db, schema, "2").path, "House/Deep");
    assert.equal(resolvePlaylist(db, schema, "House/Deep").id, 2);
    assert.equal(resolvePlaylist(db, schema, "Deep").id, 2);
    assert.equal(resolvePlaylist(db, schema, "Top 100").id, 3);
    assert.throws(() => resolvePlaylist(db, schema, "Nope"), /Playlist not found/);
  });
});

test("exportPlaylists normalizes a single playlist with rich fields", () => {
  const envelope = withDb((db, schema) => exportPlaylists(db, schema, ["House/Deep"]));
  assert.equal(envelope.source, "engine-dj");
  assert.equal(envelope.trackCount, 2);
  assert.deepEqual(
    envelope.tracks.map((t) => t.Id),
    [101, 102]
  );

  const a = envelope.tracks[0];
  assert.deepEqual(a, {
    Id: 101,
    Title: "Song A",
    Artist: "Artist A",
    Album: "Album A",
    Genre: "Deep House",
    Kind: "mp3",
    TotalTime: 200, // lengthCalculated, not length (195)
    Year: 2020,
    Bpm: 128.5, // bpmAnalyzed, not bpm (128)
    BitRate: 320000,
    Comments: "nice intro",
    Tonality: "8A", // key 1
    Label: "Label A", // publisher
    Rating: 80,
    Composer: "Composer A",
  });

  const b = envelope.tracks[1];
  assert.equal(b.Id, 102);
  assert.equal(b.Title, "Track B");
  assert.equal(b.Artist, "Unknown");
  assert.equal(b.Bpm, 124); // bpm 0 → bpmAnalyzed 124
  assert.equal(b.TotalTime, 180); // lengthCalculated NULL → length
  assert.equal(b.Tonality, undefined);
  assert.equal(b.Rating, undefined);
});

test("exportPlaylists de-dupes across playlists and sorts by stable Id", () => {
  const envelope = withDb((db, schema) =>
    exportPlaylists(db, schema, ["House/Deep", "Top 100"])
  );
  assert.equal(envelope.trackCount, 3);
  assert.deepEqual(
    envelope.tracks.map((t) => t.Id),
    [101, 102, 103]
  );
  assert.deepEqual(envelope.playlistPaths, ["House/Deep", "Top 100"]);

  const c = envelope.tracks[2];
  assert.equal(c.Id, 103);
  assert.equal(c.Title, "Bold Title"); // HTML stripped
  assert.equal(c.Artist, "Unknown Artist");
  assert.equal(c.Genre, undefined); // bracketed genre dropped
  assert.equal(c.Tonality, "8B"); // key 0
});

test("openDatabase opens read-only — writes are rejected", () => {
  const db = openDatabase(fixture.dbPath);
  try {
    assert.throws(() => db.prepare("INSERT INTO Track (id) VALUES (9999)").run());
  } finally {
    db.close();
  }
});

test("inline-schema export reads key/rating/label/composer/remixer and survives 64-bit columns", () => {
  const fx = createInlineFixtureDb();
  try {
    const db = openDatabase(fx.dbPath);
    try {
      const schema = discoverSchema(db);
      // Must not throw despite albumArtSourceHash/pdbImportKey holding values
      // beyond JS safe-integer range.
      const envelope = exportPlaylists(db, schema, ["All"]);
      assert.equal(envelope.trackCount, 2);

      const a = envelope.tracks[0];
      assert.equal(a.Id, 201);
      assert.equal(a.Tonality, "8A"); // inline key 1
      assert.equal(a.Rating, 80); // inline rating
      assert.equal(a.Label, "Label A");
      assert.equal(a.Composer, "Composer A");
      assert.equal(a.Remixer, "Remixer A");
      assert.equal(a.Bpm, 128.5);
      assert.equal(a.TotalTime, 200);

      const b = envelope.tracks[1];
      assert.equal(b.Id, 202);
      assert.equal(b.Tonality, undefined);
      assert.equal(b.Rating, undefined);
    } finally {
      db.close();
    }
  } finally {
    cleanup(fx.dir);
  }
});

test("rawInspect dumps tables and metadata type histograms", () => {
  const info = withDb((db) => rawInspect(db, { samples: 5 }));
  assert.ok(info.objects.includes("Track"));
  assert.ok(info.tables.Track.includes("bpmAnalyzed"));
  assert.equal(info.playlistLayout.kind, "entity");

  const titleType = info.metaDataTypes.find((t) => t.type === 1);
  assert.ok(titleType.samples.includes("Song A"));

  const keyType = info.metaDataIntegerTypes.find((t) => t.type === 4);
  assert.equal(keyType.min, 0);
  assert.equal(keyType.max, 1);
});

test("discoverSchema rejects a non-Engine database", () => {
  const { DatabaseSync } = require("node:sqlite");
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "not-engine-"));
  const dbPath = path.join(dir, "other.db");
  const writer = new DatabaseSync(dbPath);
  writer.exec("CREATE TABLE Songs (id INTEGER PRIMARY KEY, name TEXT)");
  writer.close();

  const db = openDatabase(dbPath);
  try {
    assert.throws(() => discoverSchema(db), /Unsupported schema/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
