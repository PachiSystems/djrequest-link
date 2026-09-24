"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  engineKeyToCamelot,
  normalizeTrack,
  buildEnvelope,
} = require("../src/catalogue/transform");

test("engineKeyToCamelot maps documented anchors and rejects out-of-range", () => {
  assert.equal(engineKeyToCamelot(0), "8B"); // C major
  assert.equal(engineKeyToCamelot(1), "8A"); // A minor
  assert.equal(engineKeyToCamelot(2), "9B");
  assert.equal(engineKeyToCamelot(22), "7B");
  assert.equal(engineKeyToCamelot(23), "7A"); // D minor
  assert.equal(engineKeyToCamelot(24), undefined);
  assert.equal(engineKeyToCamelot(-1), undefined);
  assert.equal(engineKeyToCamelot(null), undefined);
  assert.equal(engineKeyToCamelot(undefined), undefined);
});

test("normalizeTrack prefers bpmAnalyzed/lengthCalculated and converts key", () => {
  const cols = new Set([
    "id",
    "filename",
    "path",
    "bpm",
    "bpmAnalyzed",
    "length",
    "lengthCalculated",
    "year",
    "bitrate",
  ]);
  const row = {
    id: 5,
    filename: "X - Y.mp3",
    bpm: 120,
    bpmAnalyzed: 124.5,
    length: 100,
    lengthCalculated: 110,
    year: 2001,
    bitrate: 320000,
  };
  const textMeta = new Map([
    [1, "Y"],
    [2, "X"],
    [4, "Deep House"],
    [6, "Some Label"],
  ]);
  const intMeta = new Map([
    [4, 1],
    [5, 80],
  ]);

  const t = normalizeTrack(row, textMeta, intMeta, cols);
  assert.equal(t.Id, 5);
  assert.equal(t.Title, "Y");
  assert.equal(t.Artist, "X");
  assert.equal(t.Bpm, 124.5);
  assert.equal(t.TotalTime, 110);
  assert.equal(t.Year, 2001);
  assert.equal(t.BitRate, 320000);
  assert.equal(t.Genre, "Deep House");
  assert.equal(t.Tonality, "8A");
  assert.equal(t.Rating, 80);
  assert.equal(t.Label, "Some Label");
  assert.equal(t.Kind, "mp3");
});

test("normalizeTrack drops untitled rows, strips HTML, and drops bracket genres", () => {
  const cols = new Set(["id", "filename"]);

  // No metadata and a filename without "Artist - Title" → no title → dropped.
  assert.equal(normalizeTrack({ id: 9, filename: "loop.wav" }, undefined, undefined, cols), null);

  const t = normalizeTrack(
    { id: 10, filename: "a.mp3" },
    new Map([
      [1, "<b>Hi</b>"],
      [4, "Trance[x]"],
    ]),
    undefined,
    cols
  );
  assert.equal(t.Title, "Hi");
  assert.equal(t.Artist, "Unknown Artist");
  assert.equal(t.Genre, undefined);
});

test("normalizeTrack falls back to filename inference when metadata is missing", () => {
  const cols = new Set(["id", "filename"]);
  const t = normalizeTrack({ id: 11, filename: "01 - DJ Foo - Bar Baz.mp3" }, undefined, undefined, cols);
  assert.equal(t.Title, "Bar Baz");
  assert.equal(t.Artist, "DJ Foo");
});

test("buildEnvelope is deterministic: sorted, de-duped, no timestamp", () => {
  const e1 = buildEnvelope(
    [
      { Id: 2, Title: "B", Artist: "x" },
      { Id: 1, Title: "A", Artist: "y" },
    ],
    ["Z", "A", "A"]
  );
  assert.equal(e1.schemaVersion, 1);
  assert.equal(e1.source, "engine-dj");
  assert.deepEqual(e1.playlistPaths, ["A", "Z"]);
  assert.equal(e1.trackCount, 2);
  assert.deepEqual(
    e1.tracks.map((t) => t.Id),
    [1, 2]
  );
  assert.equal("generatedAt" in e1, false);

  // Same content in different input order → identical serialized bytes.
  const e2 = buildEnvelope(
    [
      { Id: 1, Title: "A", Artist: "y" },
      { Id: 2, Title: "B", Artist: "x" },
    ],
    ["A", "Z"]
  );
  assert.equal(JSON.stringify(e1), JSON.stringify(e2));
});
