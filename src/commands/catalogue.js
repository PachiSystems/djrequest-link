"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { LinkError } = require("../errors");
const { resolveApiUrl, resolveApiKey } = require("../config");
const { openDatabase } = require("../catalogue/open-db");
const {
  discoverSchema,
  listPlaylists,
  exportPlaylists,
  rawInspect,
} = require("../catalogue/engine-library");
const { runSync } = require("../catalogue/sync");
const { API_OPTIONS, out, warn, parse, requireOption, keychain } = require("./shared");

const HELP = `djrequest-link catalogue — Engine DJ library → your requestable catalogue.

Your m.db is opened strictly read-only and is never modified or uploaded.

Usage:
  djrequest-link catalogue list-playlists --db <m.db> [--json]
  djrequest-link catalogue sync    --db <m.db> --playlist <sel> [--playlist ...]
                                   [--dry-run] [--force] [--manifest <file>]
  djrequest-link catalogue export  --db <m.db> --playlist <sel> [--playlist ...] --out <file.json>
  djrequest-link catalogue inspect --db <m.db> [--json] [--samples <n>]

Commands:
  list-playlists   Print every playlist (path, id, track count).
  sync             Upload the selected playlist(s) as your requestable catalogue.
                   REPLACES your whole catalogue with exactly these tracks, so
                   pass every playlist you want live. Skips the upload when
                   nothing changed since the last sync.
  export           Write the normalized tracks to --out. Does not upload.
  inspect          Read-only schema diagnostics (tables, columns, metadata types).

Options:
  --db <path>        Engine DJ database (…/Engine Library/Database2/m.db)
  --playlist <sel>   Playlist full path (e.g. "House/Deep"), title, or numeric id.
                     Repeatable; tracks shared between playlists count once.
  --dry-run          (sync) Show track count, size and hash; no network, no key.
  --force            (sync) Upload even if unchanged since the last sync.
  --manifest <file>  (sync) Change-detection state (default
                     ./djrequest-link.manifest.json). Holds no secrets.
  --out <file>       (export) Output JSON file.
  --json             (list-playlists, inspect) Machine-readable output.
  --samples <n>      (inspect) Sample values per metadata type (default 3).
  --api-url, --api-key   See \`djrequest-link --help\`.
`;

function openLibrary(dbPath) {
  const db = openDatabase(dbPath);
  db.warnings.forEach(warn);
  return db;
}

function requirePlaylists(values) {
  if (!values.playlist || values.playlist.length === 0) {
    throw new LinkError("At least one --playlist <path-or-id> is required.", "BAD_ARGS");
  }
}

function listPlaylistsCmd(args) {
  const values = parse(args, { db: { type: "string" }, json: { type: "boolean", default: false } });
  requireOption(values.db, "--db <path>");

  const db = openLibrary(values.db);
  try {
    const playlists = listPlaylists(db, discoverSchema(db));
    if (values.json) {
      out(JSON.stringify(playlists, null, 2));
      return;
    }
    if (playlists.length === 0) {
      out("No playlists found.");
      return;
    }
    const idWidth = Math.max(2, ...playlists.map((p) => String(p.id).length));
    const countWidth = Math.max(6, ...playlists.map((p) => String(p.trackCount).length));
    out(`${"ID".padEnd(idWidth)}  ${"TRACKS".padStart(countWidth)}  PLAYLIST`);
    for (const p of playlists) {
      out(`${String(p.id).padEnd(idWidth)}  ${String(p.trackCount).padStart(countWidth)}  ${p.path}`);
    }
  } finally {
    db.close();
  }
}

function exportCmd(args) {
  const values = parse(args, {
    db: { type: "string" },
    playlist: { type: "string", multiple: true },
    out: { type: "string" },
  });
  requireOption(values.db, "--db <path>");
  requireOption(values.out, "--out <file>");
  requirePlaylists(values);

  const db = openLibrary(values.db);
  let envelope;
  try {
    envelope = exportPlaylists(db, discoverSchema(db), values.playlist);
  } finally {
    db.close();
  }
  if (envelope.tracks.length === 0) {
    throw new LinkError("No tracks found in the selected playlist(s) — nothing to export.", "EMPTY_SELECTION");
  }
  fs.writeFileSync(values.out, JSON.stringify(envelope));
  out(`Exported ${envelope.trackCount} track(s) from ${envelope.playlistPaths.length} playlist(s) to ${values.out}`);
}

function inspectCmd(args) {
  const values = parse(args, {
    db: { type: "string" },
    json: { type: "boolean", default: false },
    samples: { type: "string" },
  });
  requireOption(values.db, "--db <path>");

  const db = openLibrary(values.db);
  try {
    const info = rawInspect(db, { samples: values.samples !== undefined ? Number(values.samples) : 3 });
    if (values.json) out(JSON.stringify(info, null, 2));
    else printInspect(info);
  } finally {
    db.close();
  }
}

function printInspect(info) {
  out(`Driver: ${info.driver}`);
  out(`Tables/views: ${info.objects.join(", ")}`);
  out();
  for (const [name, columns] of Object.entries(info.tables)) out(`${name} columns: ${columns.join(", ")}`);
  out();
  if (info.playlistLayout && info.playlistLayout.error) {
    out(`Playlist layout: NOT DETECTED — ${info.playlistLayout.error}`);
  } else if (info.playlistLayout) {
    const p = info.playlistLayout;
    out(
      `Playlist layout: ${p.kind} (link=${p.link}, listCol=${p.listCol}, trackCol=${p.trackCol}, titleCol=${p.titleCol}, parentCol=${p.parentCol || "none"})`
    );
  }
  out();
  if (info.metaDataTypes) {
    out("MetaData types (type → count : samples):");
    for (const t of info.metaDataTypes) out(`  ${t.type} → ${t.count} : ${JSON.stringify(t.samples)}`);
    out();
  }
  if (info.metaDataIntegerTypes) {
    out("MetaDataInteger types (type → count [min..max] : samples):");
    for (const t of info.metaDataIntegerTypes) {
      out(`  ${t.type} → ${t.count} [${t.min}..${t.max}] : ${JSON.stringify(t.samples)}`);
    }
    out();
  }
  out(
    "Expected mapping to verify — MetaData: 1=Title 2=Artist 3=Album 4=Genre 5=Comment 6=Publisher(Label) 7=Composer 13=extension; " +
      "MetaDataInteger: 4=key(0..23→Camelot) 5=rating."
  );
}

async function syncCmd(args) {
  const values = parse(args, {
    ...API_OPTIONS,
    db: { type: "string" },
    playlist: { type: "string", multiple: true },
    manifest: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  });
  requireOption(values.db, "--db <path>");
  requirePlaylists(values);

  const apiUrl = resolveApiUrl(values["api-url"]);
  // A dry run makes no network calls, so it does not need a key.
  const apiKey = values["dry-run"]
    ? ""
    : resolveApiKey(values["api-key"], { keychain: keychain(), apiUrl });
  const manifestPath = values.manifest || path.resolve("djrequest-link.manifest.json");

  const outcome = await runSync({
    dbPath: values.db,
    apiUrl,
    apiKey,
    onWarning: warn,
    playlists: values.playlist,
    manifestPath,
    dryRun: values["dry-run"],
    force: values.force,
  });
  printSyncOutcome(outcome, manifestPath);
}

function printSyncOutcome(outcome, manifestPath) {
  const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
  if (outcome.status === "dry-run") {
    out(`[dry-run] ${outcome.trackCount} track(s), ${outcome.playlistCount} playlist(s), ~${mb(outcome.sizeBytes)}`);
    out(`[dry-run] sha256: ${outcome.hash}`);
    out(
      outcome.wouldSkip
        ? "[dry-run] Unchanged since last sync — would skip upload."
        : "[dry-run] Changed — would upload."
    );
    return;
  }
  if (outcome.status === "unchanged") {
    out(`No changes since last sync (sha256 ${outcome.hash.slice(0, 12)}…). Skipping upload.`);
    return;
  }
  out(`Synced ${outcome.trackCount} track(s) from ${outcome.playlistCount} playlist(s) (~${mb(outcome.sizeBytes)}).`);
  out(`Catalogue source set to engine-dj. Manifest: ${manifestPath}`);
}

module.exports = {
  HELP,
  commands: {
    "list-playlists": listPlaylistsCmd,
    sync: syncCmd,
    export: exportCmd,
    inspect: inspectCmd,
  },
};
