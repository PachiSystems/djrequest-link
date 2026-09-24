"use strict";

const { LinkError } = require("../errors");
const { normalizeTrack, buildEnvelope } = require("./transform");

const IDENT = /^[A-Za-z0-9_]+$/;

// ---- Schema discovery -------------------------------------------------------

function listObjects(db) {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all();
  return new Set(rows.map((r) => String(r.name)));
}

function columnSet(db, table) {
  if (!IDENT.test(table)) return new Set();
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * Defensively inspect the database and return how to read tracks + playlists.
 * Throws LinkError("UNSUPPORTED_SCHEMA") with an actionable message when a
 * required structure is missing, rather than guessing.
 */
function discoverSchema(db) {
  const objects = listObjects(db);

  if (!objects.has("Track")) {
    throw new LinkError(
      "Unsupported schema: no 'Track' table found. Is this an Engine DJ Database2/m.db?",
      "UNSUPPORTED_SCHEMA"
    );
  }
  const trackColumns = columnSet(db, "Track");

  const metaCols = objects.has("MetaData") ? columnSet(db, "MetaData") : new Set();
  const metaIntCols = objects.has("MetaDataInteger")
    ? columnSet(db, "MetaDataInteger")
    : new Set();

  const metadata = {
    hasMetaData: ["id", "type", "text"].every((c) => metaCols.has(c)),
    hasMetaDataInteger: ["id", "type", "value"].every((c) => metaIntCols.has(c)),
  };

  const playlist = detectPlaylistLayout(db, objects);

  return { objects, trackColumns, metadata, playlist };
}

function detectPlaylistLayout(db, objects) {
  if (!objects.has("Playlist")) {
    throw new LinkError(
      "Unsupported schema: no 'Playlist' table found.",
      "UNSUPPORTED_SCHEMA"
    );
  }
  const playlistCols = columnSet(db, "Playlist");
  const titleCol = pick(playlistCols, ["title", "name"]);
  if (!titleCol) {
    throw new LinkError(
      "Unsupported schema: Playlist table has no title/name column.",
      "UNSUPPORTED_SCHEMA"
    );
  }
  const parentCol = pick(playlistCols, ["parentListId", "parentId"]);

  // Engine DJ v2/v3: Playlist + PlaylistEntity(listId, trackId).
  if (objects.has("PlaylistEntity")) {
    const cols = columnSet(db, "PlaylistEntity");
    const listCol = pick(cols, ["listId", "playlistId"]);
    const trackCol = pick(cols, ["trackId"]);
    if (listCol && trackCol) {
      return { kind: "entity", link: "PlaylistEntity", titleCol, parentCol, listCol, trackCol };
    }
  }

  // Engine Prime / older: Playlist + PlaylistTrackList(playlistId, trackId).
  if (objects.has("PlaylistTrackList")) {
    const cols = columnSet(db, "PlaylistTrackList");
    const listCol = pick(cols, ["playlistId", "listId"]);
    const trackCol = pick(cols, ["trackId"]);
    if (listCol && trackCol) {
      return { kind: "tracklist", link: "PlaylistTrackList", titleCol, parentCol, listCol, trackCol };
    }
  }

  throw new LinkError(
    "Unsupported schema: could not find a PlaylistEntity or PlaylistTrackList linking table.",
    "UNSUPPORTED_SCHEMA"
  );
}

function pick(set, candidates) {
  for (const c of candidates) {
    if (set.has(c)) return c;
  }
  return null;
}

// ---- Playlists --------------------------------------------------------------

/**
 * Return every playlist with its hierarchical path (e.g. "House/Deep") and a
 * track count, sorted by path. Folder/container rows are included (they simply
 * report the tracks linked directly to them, usually 0).
 */
function listPlaylists(db, schema) {
  const { playlist } = schema;
  const select = playlist.parentCol
    ? `SELECT id, ${playlist.titleCol} AS title, ${playlist.parentCol} AS parentId FROM Playlist`
    : `SELECT id, ${playlist.titleCol} AS title FROM Playlist`;

  const rows = db
    .prepare(select)
    .all()
    .map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      parentId: playlist.parentCol ? Number(r.parentId) : 0,
    }));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM ${playlist.link} WHERE ${playlist.listCol} = ?`
  );

  const result = rows.map((r) => ({
    id: r.id,
    title: r.title,
    path: buildPath(r, byId),
    trackCount: Number(countStmt.get(r.id).c),
  }));

  result.sort((a, b) => a.path.localeCompare(b.path) || a.id - b.id);
  return result;
}

function buildPath(row, byId) {
  const parts = [];
  const seen = new Set();
  let current = row;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.title);
    const parentId = current.parentId;
    current = parentId && byId.has(parentId) ? byId.get(parentId) : null;
  }
  return parts.join("/");
}

/**
 * Resolve a user selector (numeric id, full path, or unique title) to a single
 * playlist. Throws LinkError("PLAYLIST_NOT_FOUND") when missing/ambiguous.
 */
function resolvePlaylist(db, schema, selector) {
  const playlists = listPlaylists(db, schema);
  const sel = String(selector).trim();

  if (/^\d+$/.test(sel)) {
    const byId = playlists.find((p) => String(p.id) === sel);
    if (byId) return byId;
  }

  const byPath = playlists.find((p) => p.path === sel);
  if (byPath) return byPath;

  const byTitle = playlists.filter((p) => p.title === sel);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw new LinkError(
      `Playlist "${sel}" is ambiguous (matches ${byTitle.length} playlists). Use the full path or numeric id.`,
      "PLAYLIST_NOT_FOUND"
    );
  }

  throw new LinkError(
    `Playlist not found: "${sel}". Run \`list-playlists\` to see available playlists.`,
    "PLAYLIST_NOT_FOUND"
  );
}

// Only the Track columns we actually normalize. Selecting an explicit list
// (instead of `t.*`) keeps us off Engine DJ's 64-bit columns such as
// albumArtSourceHash / pdbImportKey / originTrackId, whose values can exceed
// JavaScript's safe-integer range — node:sqlite throws RangeError when
// materializing those. It is also less data to read.
const WANTED_TRACK_COLUMNS = [
  "id",
  "length",
  "lengthCalculated",
  "bpm",
  "bpmAnalyzed",
  "year",
  "path",
  "filename",
  "bitrate",
  "title",
  "artist",
  "album",
  "genre",
  "comment",
  "label",
  "composer",
  "remixer",
  "key",
  "rating",
];

function trackSelectColumns(trackColumns) {
  const cols = WANTED_TRACK_COLUMNS.filter((c) => trackColumns.has(c));
  if (!cols.includes("id")) cols.unshift("id"); // required for join + dedupe
  return cols;
}

function getPlaylistTrackRows(db, schema, playlistId) {
  const { playlist } = schema;
  const select = trackSelectColumns(schema.trackColumns)
    .map((c) => `t.${c}`)
    .join(", ");
  return db
    .prepare(
      `SELECT ${select} FROM ${playlist.link} pe JOIN Track t ON t.id = pe.${playlist.trackCol} WHERE pe.${playlist.listCol} = ?`
    )
    .all(playlistId);
}

// ---- Metadata join ----------------------------------------------------------

function fetchMetadata(db, schema, trackIds) {
  const textByTrack = new Map();
  const intByTrack = new Map();
  if (trackIds.length === 0) return { textByTrack, intByTrack };

  if (schema.metadata.hasMetaData) {
    bulkSelect(db, "SELECT id, type, text FROM MetaData WHERE id IN", trackIds, (row) => {
      const id = Number(row.id);
      let m = textByTrack.get(id);
      if (!m) {
        m = new Map();
        textByTrack.set(id, m);
      }
      m.set(Number(row.type), row.text);
    });
  }

  if (schema.metadata.hasMetaDataInteger) {
    bulkSelect(db, "SELECT id, type, value FROM MetaDataInteger WHERE id IN", trackIds, (row) => {
      const id = Number(row.id);
      let m = intByTrack.get(id);
      if (!m) {
        m = new Map();
        intByTrack.set(id, m);
      }
      m.set(Number(row.type), row.value);
    });
  }

  return { textByTrack, intByTrack };
}

// Chunk IN(...) queries to stay under SQLite's bound-variable limit (999).
function bulkSelect(db, prefix, ids, onRow) {
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.prepare(`${prefix} (${placeholders})`).all(...chunk);
    for (const row of rows) onRow(row);
  }
}

// ---- Export -----------------------------------------------------------------

/**
 * Resolve the selected playlists, collect their tracks (de-duped by stable id),
 * normalize them, and return the deterministic sync envelope.
 */
function exportPlaylists(db, schema, selectors) {
  const resolved = selectors.map((sel) => resolvePlaylist(db, schema, sel));
  const playlistPaths = resolved.map((p) => p.path);

  const rowById = new Map();
  for (const pl of resolved) {
    for (const row of getPlaylistTrackRows(db, schema, pl.id)) {
      const id = Number(row.id);
      if (!rowById.has(id)) rowById.set(id, row);
    }
  }

  const ids = [...rowById.keys()];
  const { textByTrack, intByTrack } = fetchMetadata(db, schema, ids);

  const tracks = [];
  for (const [id, row] of rowById) {
    const track = normalizeTrack(row, textByTrack.get(id), intByTrack.get(id), schema.trackColumns);
    if (track) tracks.push(track);
  }

  return buildEnvelope(tracks, playlistPaths);
}

// ---- Inspection (read-only diagnostics) ------------------------------------

// Allow-list of table names worth dumping columns for. Used only as literal
// identifiers in queries (never user input).
const INSPECT_TABLES = [
  "Track",
  "MetaData",
  "MetaDataInteger",
  "Playlist",
  "PlaylistEntity",
  "PlaylistTrackList",
  "Information",
];

/**
 * Dump the actual schema + metadata type histograms for a real m.db so the
 * documented enums/key mapping can be verified or corrected. Independent of
 * discoverSchema (it must work even when the schema is unexpected). Read-only
 * and bounded (sample counts are clamped).
 */
function rawInspect(db, options = {}) {
  const samples = Math.max(0, Math.min(Math.trunc(Number(options.samples) || 3), 20));
  const objects = [...listObjects(db)].sort();

  const tables = {};
  for (const name of INSPECT_TABLES) {
    if (objects.includes(name)) tables[name] = [...columnSet(db, name)];
  }

  const result = { driver: db.driver || "unknown", objects, tables };

  try {
    result.playlistLayout = detectPlaylistLayout(db, new Set(objects));
  } catch (err) {
    result.playlistLayout = { error: err.message };
  }

  if (tables.MetaData && ["id", "type", "text"].every((c) => tables.MetaData.includes(c))) {
    result.metaDataTypes = textTypeHistogram(db, "MetaData", samples);
  }
  if (
    tables.MetaDataInteger &&
    ["id", "type", "value"].every((c) => tables.MetaDataInteger.includes(c))
  ) {
    result.metaDataIntegerTypes = intTypeHistogram(db, "MetaDataInteger", samples);
  }

  return result;
}

function textTypeHistogram(db, table, samples) {
  const rows = db
    .prepare(`SELECT type, COUNT(*) AS count FROM ${table} GROUP BY type ORDER BY type`)
    .all();
  const sampleStmt = db.prepare(`SELECT text AS v FROM ${table} WHERE type = ? LIMIT ${samples}`);
  return rows.map((r) => ({
    type: Number(r.type),
    count: Number(r.count),
    samples: samples > 0 ? sampleStmt.all(r.type).map((s) => s.v) : [],
  }));
}

function intTypeHistogram(db, table, samples) {
  const rows = db
    .prepare(
      `SELECT type, COUNT(*) AS count, MIN(value) AS min, MAX(value) AS max FROM ${table} GROUP BY type ORDER BY type`
    )
    .all();
  const sampleStmt = db.prepare(`SELECT value AS v FROM ${table} WHERE type = ? LIMIT ${samples}`);
  return rows.map((r) => ({
    type: Number(r.type),
    count: Number(r.count),
    min: r.min === null ? null : Number(r.min),
    max: r.max === null ? null : Number(r.max),
    samples: samples > 0 ? sampleStmt.all(r.type).map((s) => Number(s.v)) : [],
  }));
}

module.exports = {
  discoverSchema,
  listPlaylists,
  resolvePlaylist,
  getPlaylistTrackRows,
  fetchMetadata,
  exportPlaylists,
  rawInspect,
};
