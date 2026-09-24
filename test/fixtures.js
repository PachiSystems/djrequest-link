"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { META_TEXT, META_INT } = require("../src/catalogue/transform");

/**
 * Build a small synthetic Engine DJ database matching the documented v2/v3
 * layout (Track + MetaData + MetaDataInteger + Playlist + PlaylistEntity).
 * Written with the built-in node:sqlite driver; the tool opens it read-only.
 *
 * @returns {{ dir: string, dbPath: string }}
 */
function createFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-dj-fixture-"));
  const dbPath = path.join(dir, "m.db");
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE Track (
      id INTEGER PRIMARY KEY,
      playOrder INTEGER,
      length INTEGER,
      lengthCalculated INTEGER,
      bpm INTEGER,
      year INTEGER,
      path TEXT,
      filename TEXT,
      bitrate INTEGER,
      bpmAnalyzed REAL,
      trackType INTEGER,
      isExternalTrack NUMERIC,
      uuidOfExternalDatabase TEXT,
      idTrackInExternalDatabase INTEGER,
      idAlbumArt INTEGER
    );
    CREATE TABLE MetaData (id INTEGER, type INTEGER, text TEXT, PRIMARY KEY (id, type));
    CREATE TABLE MetaDataInteger (id INTEGER, type INTEGER, value INTEGER, PRIMARY KEY (id, type));
    CREATE TABLE Playlist (id INTEGER PRIMARY KEY, title TEXT, parentListId INTEGER);
    CREATE TABLE PlaylistEntity (
      id INTEGER PRIMARY KEY,
      listId INTEGER,
      trackId INTEGER,
      membershipReference INTEGER,
      databaseUuid TEXT,
      nextEntityId INTEGER
    );
  `);

  const insTrack = db.prepare(
    `INSERT INTO Track (id, length, lengthCalculated, bpm, year, path, filename, bitrate, bpmAnalyzed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 101: full metadata. bpmAnalyzed (128.5) should win over bpm (128);
  // lengthCalculated (200) should win over length (195).
  insTrack.run(101, 195, 200, 128, 2020, "Music/Artist A - Song A.mp3", "Artist A - Song A.mp3", 320000, 128.5);
  // 102: sparse. lengthCalculated NULL → fall back to length (180); bpm 0 → use bpmAnalyzed.
  insTrack.run(102, 180, null, 0, null, "Music/Unknown - Track B.mp3", "Unknown - Track B.mp3", null, 124.0);
  // 103: HTML title + bracketed genre + key 0.
  insTrack.run(103, 210, 210, 130, 2019, "Music/clip.mp3", "clip.mp3", 256000, 130.0);

  const insText = db.prepare(`INSERT INTO MetaData (id, type, text) VALUES (?, ?, ?)`);
  insText.run(101, META_TEXT.TITLE, "Song A");
  insText.run(101, META_TEXT.ARTIST, "Artist A");
  insText.run(101, META_TEXT.ALBUM, "Album A");
  insText.run(101, META_TEXT.GENRE, "Deep House");
  insText.run(101, META_TEXT.COMMENT, "nice intro");
  insText.run(101, META_TEXT.PUBLISHER, "Label A");
  insText.run(101, META_TEXT.COMPOSER, "Composer A");
  insText.run(101, META_TEXT.EXTENSION, "mp3");
  insText.run(102, META_TEXT.TITLE, "Track B");
  insText.run(102, META_TEXT.ARTIST, "Unknown");
  insText.run(103, META_TEXT.TITLE, "<b>Bold</b> Title");
  insText.run(103, META_TEXT.GENRE, "Trance[hard]");

  const insInt = db.prepare(`INSERT INTO MetaDataInteger (id, type, value) VALUES (?, ?, ?)`);
  insInt.run(101, META_INT.KEY, 1); // → 8A
  insInt.run(101, META_INT.RATING, 80);
  insInt.run(103, META_INT.KEY, 0); // → 8B

  const insList = db.prepare(`INSERT INTO Playlist (id, title, parentListId) VALUES (?, ?, ?)`);
  insList.run(1, "House", 0); // folder/container
  insList.run(2, "Deep", 1); // → "House/Deep"
  insList.run(3, "Top 100", 0);

  const insEntity = db.prepare(`INSERT INTO PlaylistEntity (id, listId, trackId) VALUES (?, ?, ?)`);
  insEntity.run(1, 2, 101); // Deep → 101
  insEntity.run(2, 2, 102); // Deep → 102
  insEntity.run(3, 3, 102); // Top 100 → 102 (shared with Deep)
  insEntity.run(4, 3, 103); // Top 100 → 103

  db.close();
  return { dir, dbPath };
}

/**
 * Build a synthetic Engine DJ v3 database using the INLINE-column layout (no
 * MetaData/MetaDataInteger), mirroring a real m.db. Includes 64-bit columns
 * (albumArtSourceHash, pdbImportKey) with values beyond JS safe-integer range to
 * guard against the `t.*` RangeError regression.
 *
 * @returns {{ dir: string, dbPath: string }}
 */
function createInlineFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-dj-inline-"));
  const dbPath = path.join(dir, "m.db");
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE Track (
      id INTEGER PRIMARY KEY,
      length INTEGER,
      bpm INTEGER,
      year INTEGER,
      path TEXT,
      filename TEXT,
      bitrate INTEGER,
      bpmAnalyzed REAL,
      title TEXT,
      artist TEXT,
      album TEXT,
      genre TEXT,
      comment TEXT,
      label TEXT,
      composer TEXT,
      remixer TEXT,
      key INTEGER,
      rating INTEGER,
      albumArtSourceHash INTEGER,
      pdbImportKey INTEGER
    );
    CREATE TABLE Playlist (id INTEGER PRIMARY KEY, title TEXT, parentListId INTEGER);
    CREATE TABLE PlaylistEntity (id INTEGER PRIMARY KEY, listId INTEGER, trackId INTEGER);
  `);

  const insTrack = db.prepare(
    `INSERT INTO Track
       (id, length, bpm, year, path, filename, bitrate, bpmAnalyzed, title, artist,
        album, genre, comment, label, composer, remixer, key, rating,
        albumArtSourceHash, pdbImportKey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 201: full inline metadata + huge 64-bit columns (the values that crashed `t.*`).
  insTrack.run(
    201, 200, 128, 2020, "Music/A - B.mp3", "A - B.mp3", 320000, 128.5,
    "Song A", "Artist A", "Album A", "Deep House", "comment", "Label A", "Composer A",
    "Remixer A", 1, 80, 3664997586265197577n, 9223372036854775807n
  );
  // 202: sparse — no key/rating/label/composer/remixer.
  insTrack.run(
    202, 180, 124, null, "Music/x.mp3", "x.mp3", null, 124.0,
    "Track B", "Unknown", null, null, null, null, null, null, null, null, 123n, 1n
  );

  db.prepare(`INSERT INTO Playlist (id, title, parentListId) VALUES (?, ?, ?)`).run(10, "All", 0);
  const insEntity = db.prepare(`INSERT INTO PlaylistEntity (id, listId, trackId) VALUES (?, ?, ?)`);
  insEntity.run(1, 10, 201);
  insEntity.run(2, 10, 202);

  db.close();
  return { dir, dbPath };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { createFixtureDb, createInlineFixtureDb, cleanup };
