"use strict";

const { openDatabase } = require("./open-db");
const { discoverSchema, exportPlaylists } = require("./engine-library");
const { sha256Hex } = require("../hash");
const { readManifest, writeManifest } = require("./manifest");
const { createApiClient } = require("../api-client");
const { LinkError } = require("../errors");

const DEFAULT_FILE_NAME = "engine-dj-selected-catalogue.json";

function buildEnvelopeFromDb(dbPath, playlists, onWarning = () => {}) {
  const db = openDatabase(dbPath);
  try {
    db.warnings.forEach(onWarning);
    const schema = discoverSchema(db);
    return exportPlaylists(db, schema, playlists);
  } finally {
    db.close();
  }
}

/**
 * Export the selected playlists, hash the normalized envelope, and (unless
 * unchanged or dry-run) upload it via the signed-URL flow:
 *   upload-url → PUT envelope → finalize, then update the manifest.
 *
 * The SHA-256 is computed over the exact bytes uploaded, so it serves both the
 * manifest change-detection and the server's integrity check. Returns a
 * structured outcome; never prints (the CLI layer prints).
 */
async function runSync(options) {
  const {
    dbPath,
    apiUrl,
    apiKey,
    playlists,
    manifestPath,
    dryRun = false,
    force = false,
    fetchImpl,
    now = () => new Date(),
    onWarning,
  } = options;

  if (!apiUrl) throw new LinkError("Missing required --api-url.", "BAD_ARGS");
  if (!apiKey && !dryRun) {
    throw new LinkError(
      "Missing API key. Set DJREQUEST_API_KEY or pass --api-key.",
      "BAD_ARGS"
    );
  }
  if (!playlists || playlists.length === 0) {
    throw new LinkError("At least one --playlist is required.", "BAD_ARGS");
  }

  const envelope = buildEnvelopeFromDb(dbPath, playlists, onWarning);
  if (envelope.tracks.length === 0) {
    throw new LinkError(
      "No tracks found in the selected playlist(s) — nothing to sync.",
      "EMPTY_SELECTION"
    );
  }

  const bytes = Buffer.from(JSON.stringify(envelope), "utf-8");
  const sha256 = sha256Hex(bytes);
  const sizeBytes = bytes.length;
  const trackCount = envelope.trackCount;
  const playlistCount = envelope.playlistPaths.length;

  const manifest = manifestPath ? readManifest(manifestPath) : null;
  const unchanged = !!manifest && manifest.lastHash === sha256 && manifest.apiUrl === apiUrl;

  if (dryRun) {
    return { status: "dry-run", hash: sha256, trackCount, playlistCount, sizeBytes, wouldSkip: unchanged };
  }

  if (unchanged && !force) {
    return { status: "unchanged", hash: sha256, trackCount, playlistCount };
  }

  const client = createApiClient({ apiUrl, apiKey, fetchImpl });

  const upload = await client.requestUploadUrl({
    fileName: DEFAULT_FILE_NAME,
    fileSize: sizeBytes,
    sha256,
    trackCount,
    playlistPaths: envelope.playlistPaths,
  });

  if (typeof upload.maxBytes === "number" && sizeBytes > upload.maxBytes) {
    throw new LinkError(
      `Normalized catalogue is ${mb(sizeBytes)}, over the server limit of ${mb(upload.maxBytes)}.`,
      "TOO_LARGE"
    );
  }

  await client.putEnvelope(upload.uploadUrl, upload.contentType || "application/json", bytes);

  const result = await client.finalize({
    objectPath: upload.objectPath,
    sha256,
    trackCount,
    playlistPaths: envelope.playlistPaths,
  });

  if (manifestPath) {
    writeManifest(manifestPath, {
      apiUrl,
      dbPath,
      playlistPaths: envelope.playlistPaths,
      lastHash: sha256,
      lastSyncedAt: now().toISOString(),
      lastTrackCount: result.trackCount ?? trackCount,
    });
  }

  return {
    status: "synced",
    hash: sha256,
    trackCount: result.trackCount ?? trackCount,
    playlistCount,
    sizeBytes,
    finalize: result,
  };
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

module.exports = { runSync, buildEnvelopeFromDb, DEFAULT_FILE_NAME };
