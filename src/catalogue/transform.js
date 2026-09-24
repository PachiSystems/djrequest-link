"use strict";

/**
 * Normalization from Engine DJ rows to the web app's `Track` shape, plus the
 * deterministic sync envelope. Field/enum knowledge comes from the Mixxx
 * "Engine Library Format" notes:
 *
 *   - Textual metadata lives in `MetaData(id, type, text)` keyed by `type`.
 *   - Integer metadata lives in `MetaDataInteger(id, type, value)`.
 *   - Musical key is MetaDataInteger type 4, an integer 0..23 mapping to Camelot.
 *
 * VERIFY against a real m.db before trusting in production: the exact `type`
 * enum values and the key integer mapping can vary by Engine DJ version. They
 * are centralized here so corrections are a one-line change.
 */

// MetaData.type (text values).
const META_TEXT = {
  TITLE: 1,
  ARTIST: 2,
  ALBUM: 3,
  GENRE: 4,
  COMMENT: 5,
  PUBLISHER: 6, // → Track.Label
  COMPOSER: 7,
  EXTENSION: 13, // → Track.Kind
};

// MetaDataInteger.type (integer values).
const META_INT = {
  KEY: 4, // 0..23 → Camelot
  RATING: 5,
};

/**
 * Engine DJ MetaDataInteger type=4 stores musical key as an integer 0..23.
 * Documented anchors: 0 => 8B (C major), 1 => 8A (A minor), 23 => 7A (D minor).
 * The wheel advances one Camelot number every two indices; even = B (major),
 * odd = A (minor).
 * @returns {string|undefined} Camelot text like "8A", or undefined if out of range
 */
function engineKeyToCamelot(value) {
  if (value === null || value === undefined) return undefined;
  const v = Number(value);
  if (!Number.isInteger(v) || v < 0 || v > 23) return undefined;
  const number = ((7 + Math.floor(v / 2)) % 12) + 1;
  const letter = v % 2 === 0 ? "B" : "A";
  return `${number}${letter}`;
}

/** Strip HTML tags + trim, mirroring the app's sanitizeText. */
function sanitizeText(input) {
  if (input === null || input === undefined) return "";
  return String(input)
    .replace(/<[^>]*>/g, "")
    .trim();
}

/** Mirror the app's sanitizeGenre: drop genres containing brackets. */
function sanitizeGenre(genre) {
  if (genre === null || genre === undefined) return undefined;
  const text = String(genre);
  if (text.includes("[") || text.includes("]")) return undefined;
  return text;
}

function optionalText(value) {
  const text = sanitizeText(value);
  return text ? text : undefined;
}

function toPositiveInteger(value) {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  return rounded > 0 ? rounded : undefined;
}

function toPositiveNumber(value) {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n > 0 ? n : undefined;
}

function inferExtension(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(/\.([a-z0-9]+)$/i);
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

/** Best-effort "Artist - Title" inference from a filename/path basename. */
function inferArtistAndTitle(value) {
  if (typeof value !== "string" || !value) return {};
  const basename = value
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, "")
    .replace(/^\s*\d+\s*[-._]\s*/, "")
    .replace(/^\s*-\s*/, "")
    .trim();

  if (!basename || !basename.includes(" - ")) return {};

  const [artist, ...titleParts] = basename.split(" - ");
  const title = titleParts.join(" - ").trim();
  if (!artist || !title) return {};
  return { artist: sanitizeText(artist), title: sanitizeText(title) };
}

function metaText(textMeta, type) {
  if (!textMeta) return undefined;
  return optionalText(textMeta.get(type));
}

/**
 * Normalize one Engine DJ Track row (+ its joined metadata) to a `Track`.
 * Prefers richer fields (bpmAnalyzed over bpm, lengthCalculated over length).
 * Returns null when no usable title can be derived (matches the web importer,
 * which drops untitled rows rather than inventing placeholders).
 *
 * @param {object} row Track table row
 * @param {Map<number,string>|undefined} textMeta type → text for this track
 * @param {Map<number,number>|undefined} intMeta type → value for this track
 * @param {{ has: (col: string) => boolean }} trackColumns discovered Track columns
 */
function normalizeTrack(row, textMeta, intMeta, trackColumns) {
  const col = (name) => (trackColumns.has(name) ? row[name] : undefined);

  const id = toPositiveInteger(row.id);
  if (id === undefined) return null;

  const filename = optionalText(col("filename"));
  const path = optionalText(col("path"));

  const metaTitle = metaText(textMeta, META_TEXT.TITLE) || optionalText(col("title"));
  const metaArtist = metaText(textMeta, META_TEXT.ARTIST) || optionalText(col("artist"));

  const inferred = inferArtistAndTitle(filename);
  const inferredFromPath = inferArtistAndTitle(path);

  const title = sanitizeText(
    metaTitle || inferred.title || inferredFromPath.title || ""
  );
  if (!title) return null;

  const artist = sanitizeText(
    metaArtist || inferred.artist || inferredFromPath.artist || ""
  ) || "Unknown Artist";

  /** @type {Record<string, unknown>} */
  const track = { Id: id, Title: title, Artist: artist };

  const album = metaText(textMeta, META_TEXT.ALBUM) || optionalText(col("album"));
  if (album) track.Album = album;

  const genre = sanitizeGenre(metaText(textMeta, META_TEXT.GENRE) || optionalText(col("genre")));
  if (genre) track.Genre = genre;

  const kind =
    metaText(textMeta, META_TEXT.EXTENSION) || inferExtension(filename, path);
  if (kind) track.Kind = kind;

  const totalTime = toPositiveInteger(col("lengthCalculated")) ?? toPositiveInteger(col("length"));
  if (totalTime !== undefined) track.TotalTime = totalTime;

  const year = toPositiveInteger(col("year"));
  if (year !== undefined) track.Year = year;

  const bpm = toPositiveNumber(col("bpmAnalyzed")) ?? toPositiveNumber(col("bpm"));
  if (bpm !== undefined) track.Bpm = bpm;

  const bitRate = toPositiveInteger(col("bitrate"));
  if (bitRate !== undefined) track.BitRate = bitRate;

  const comments = metaText(textMeta, META_TEXT.COMMENT) || optionalText(col("comment"));
  if (comments) track.Comments = comments;

  // Key/rating live in MetaDataInteger on older schemas and as inline Track
  // columns on newer ones (Engine DJ v3). Prefer MetaData* when present, else
  // the inline column.
  const tonality = engineKeyToCamelot(pickInt(intMeta, META_INT.KEY, col("key")));
  if (tonality) track.Tonality = tonality;

  const label = metaText(textMeta, META_TEXT.PUBLISHER) || optionalText(col("label"));
  if (label) track.Label = label;

  const rating = toPositiveInteger(pickInt(intMeta, META_INT.RATING, col("rating")));
  if (rating !== undefined) track.Rating = rating;

  const composer = metaText(textMeta, META_TEXT.COMPOSER) || optionalText(col("composer"));
  if (composer) track.Composer = composer;

  // Remixer has no documented MetaData type; read it from the inline column.
  const remixer = optionalText(col("remixer"));
  if (remixer) track.Remixer = remixer;

  return track;
}

// Prefer a MetaDataInteger value when present, else the inline Track column.
function pickInt(intMeta, type, inlineValue) {
  if (intMeta) {
    const value = intMeta.get(type);
    if (value !== undefined && value !== null) return value;
  }
  return inlineValue;
}

/**
 * Build the deterministic sync envelope. Tracks are sorted by stable Id and
 * playlist paths are de-duplicated + sorted so the same library always
 * serializes to identical bytes — this is what makes SHA-256 change-detection
 * (Chunk 4) reliable. No timestamp is embedded for the same reason; the sync
 * time is recorded in the manifest instead.
 */
function buildEnvelope(tracks, playlistPaths) {
  const sortedTracks = [...tracks].sort((a, b) => a.Id - b.Id);
  const sortedPaths = [...new Set(playlistPaths)].sort();
  return {
    schemaVersion: 1,
    source: "engine-dj",
    playlistPaths: sortedPaths,
    trackCount: sortedTracks.length,
    tracks: sortedTracks,
  };
}

module.exports = {
  META_TEXT,
  META_INT,
  engineKeyToCamelot,
  sanitizeText,
  sanitizeGenre,
  normalizeTrack,
  buildEnvelope,
};
