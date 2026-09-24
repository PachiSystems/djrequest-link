"use strict";

const fs = require("node:fs");
const { LinkError } = require("../errors");

const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Read a sync manifest. Returns null if it does not exist. The manifest tracks
 * the last sync (hash, timestamp, playlist selection, api url) so unchanged
 * libraries can be skipped. It intentionally NEVER stores the API key.
 */
function readManifest(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    throw new LinkError(
      `Could not read manifest at ${manifestPath}: ${err.message}`,
      "MANIFEST_READ"
    );
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    throw new LinkError(
      `Manifest at ${manifestPath} is not valid JSON.`,
      "MANIFEST_READ"
    );
  }
}

function writeManifest(manifestPath, data) {
  const payload = { schemaVersion: MANIFEST_SCHEMA_VERSION, ...data };
  fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
}

module.exports = { readManifest, writeManifest, MANIFEST_SCHEMA_VERSION };
