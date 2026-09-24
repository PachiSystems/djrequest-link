"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { LinkError } = require("./errors");
const { resolveApiUrl, resolveApiKey, ENV_API_KEY, ENV_API_URL, DEFAULT_API_URL } = require("./config");
const { openDatabase } = require("./catalogue/open-db");
const {
  discoverSchema,
  listPlaylists,
  exportPlaylists,
  rawInspect,
} = require("./catalogue/engine-library");
const { runSync } = require("./catalogue/sync");
const { version } = require("../package.json");

const HELP = `djrequest-link — local companion for DJRequest.me.

Usage:
  djrequest-link catalogue list-playlists --db <m.db> [--json]
  djrequest-link catalogue export  --db <m.db> --playlist <sel> [--playlist ...] --out <file.json>
  djrequest-link catalogue inspect --db <m.db> [--json] [--samples <n>]
  djrequest-link catalogue sync    --db <m.db> --playlist <sel> [--playlist ...]
                                   [--api-url <url>] [--api-key <key>] [--manifest <file>]
                                   [--dry-run] [--force]

Catalogue commands (Engine DJ). Your m.db is opened strictly read-only and is
never modified or uploaded:
  list-playlists   Print every playlist (path, id, track count).
  export           Write the normalized tracks of the selected playlist(s) to
                   --out. Does not upload.
  inspect          Read-only diagnostics: tables/columns and metadata type
                   histograms with sample values (for verifying the schema).
  sync             Upload the selected playlist(s) as your requestable catalogue.
                   REPLACES your whole catalogue with exactly these tracks, so
                   pass every playlist you want live. Skips the upload when
                   nothing changed since the last sync.

Options:
  --db <path>        Engine DJ database (…/Engine Library/Database2/m.db)
  --playlist <sel>   Playlist full path (e.g. "House/Deep"), title, or numeric id.
                     Repeatable; tracks shared between playlists are de-duplicated.
  --out <file>       Output JSON file for export.
  --api-url <url>    DJRequest.me base URL. Falls back to ${ENV_API_URL}, then
                     ${DEFAULT_API_URL}. Must be https:// (http://localhost allowed).
  --api-key <key>    Developer API key. Prefer setting ${ENV_API_KEY} instead:
                     flags end up in your shell history. Never written to disk.
  --manifest <file>  (sync) Change-detection state file
                     (default ./djrequest-link.manifest.json). Holds no secrets.
  --dry-run          (sync) Print track/playlist count, hash, size; no network.
  --force            (sync) Upload even if unchanged since the last sync.
  --json             Machine-readable output (list-playlists, inspect).
  --samples <n>      (inspect) Sample values per metadata type (default 3).
  -h, --help         Show this help.
  -v, --version      Show the version.
`;

const CATALOGUE_COMMANDS = {
  "list-playlists": cmdListPlaylists,
  export: cmdExport,
  inspect: cmdInspect,
  sync: cmdSync,
};

function run(argv = process.argv) {
  const [group, command, ...args] = argv.slice(2);

  switch (group) {
    case "catalogue": {
      const handler = CATALOGUE_COMMANDS[command];
      if (!handler) {
        throw new LinkError(
          `Unknown catalogue command: ${command ?? "(none)"}. Expected one of: ${Object.keys(CATALOGUE_COMMANDS).join(", ")}.`,
          "BAD_ARGS"
        );
      }
      return handler(args);
    }
    case "-v":
    case "--version":
      process.stdout.write(`${version}
`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      throw new LinkError(`Unknown command: ${group}

${HELP}`, "BAD_ARGS");
  }
}

function warn(message) {
  process.stderr.write(`Warning: ${message}
`);
}

function openLibrary(dbPath) {
  const db = openDatabase(dbPath);
  db.warnings.forEach(warn);
  return db;
}

function cmdListPlaylists(args) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });

  requireOption(values.db, "--db <path>");

  const db = openLibrary(values.db);
  try {
    const schema = discoverSchema(db);
    const playlists = listPlaylists(db, schema);

    if (values.json) {
      process.stdout.write(`${JSON.stringify(playlists, null, 2)}\n`);
      return;
    }

    if (playlists.length === 0) {
      process.stdout.write("No playlists found.\n");
      return;
    }

    const idWidth = Math.max(2, ...playlists.map((p) => String(p.id).length));
    const countWidth = Math.max(6, ...playlists.map((p) => String(p.trackCount).length));
    process.stdout.write(
      `${"ID".padEnd(idWidth)}  ${"TRACKS".padStart(countWidth)}  PLAYLIST\n`
    );
    for (const p of playlists) {
      process.stdout.write(
        `${String(p.id).padEnd(idWidth)}  ${String(p.trackCount).padStart(countWidth)}  ${p.path}\n`
      );
    }
  } finally {
    db.close();
  }
}

function cmdExport(args) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      playlist: { type: "string", multiple: true },
      out: { type: "string" },
    },
  });

  requireOption(values.db, "--db <path>");
  requireOption(values.out, "--out <file>");
  if (!values.playlist || values.playlist.length === 0) {
    throw new LinkError("At least one --playlist <path-or-id> is required.", "BAD_ARGS");
  }

  const db = openLibrary(values.db);
  let envelope;
  try {
    const schema = discoverSchema(db);
    envelope = exportPlaylists(db, schema, values.playlist);
  } finally {
    db.close();
  }

  if (envelope.tracks.length === 0) {
    throw new LinkError(
      "No tracks found in the selected playlist(s) — nothing to export.",
      "EMPTY_SELECTION"
    );
  }

  fs.writeFileSync(values.out, JSON.stringify(envelope));
  process.stdout.write(
    `Exported ${envelope.trackCount} track(s) from ${envelope.playlistPaths.length} playlist(s) to ${values.out}\n`
  );
}

function cmdInspect(args) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      json: { type: "boolean", default: false },
      samples: { type: "string" },
    },
  });

  requireOption(values.db, "--db <path>");

  const db = openLibrary(values.db);
  try {
    const info = rawInspect(db, {
      samples: values.samples !== undefined ? Number(values.samples) : 3,
    });

    if (values.json) {
      process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
      return;
    }

    printInspect(info);
  } finally {
    db.close();
  }
}

function printInspect(info) {
  const out = (s) => process.stdout.write(`${s}\n`);
  out(`Driver: ${info.driver}`);
  out(`Tables/views: ${info.objects.join(", ")}`);
  out("");

  for (const [name, columns] of Object.entries(info.tables)) {
    out(`${name} columns: ${columns.join(", ")}`);
  }
  out("");

  if (info.playlistLayout && info.playlistLayout.error) {
    out(`Playlist layout: NOT DETECTED — ${info.playlistLayout.error}`);
  } else if (info.playlistLayout) {
    const p = info.playlistLayout;
    out(
      `Playlist layout: ${p.kind} (link=${p.link}, listCol=${p.listCol}, trackCol=${p.trackCol}, titleCol=${p.titleCol}, parentCol=${p.parentCol || "none"})`
    );
  }
  out("");

  if (info.metaDataTypes) {
    out("MetaData types (type → count : samples):");
    for (const t of info.metaDataTypes) {
      out(`  ${t.type} → ${t.count} : ${JSON.stringify(t.samples)}`);
    }
    out("");
  }

  if (info.metaDataIntegerTypes) {
    out("MetaDataInteger types (type → count [min..max] : samples):");
    for (const t of info.metaDataIntegerTypes) {
      out(`  ${t.type} → ${t.count} [${t.min}..${t.max}] : ${JSON.stringify(t.samples)}`);
    }
    out("");
  }

  out(
    "Expected mapping to verify — MetaData: 1=Title 2=Artist 3=Album 4=Genre 5=Comment 6=Publisher(Label) 7=Composer 13=extension; " +
      "MetaDataInteger: 4=key(0..23→Camelot) 5=rating."
  );
}

async function cmdSync(args) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      "api-url": { type: "string" },
      "api-key": { type: "string" },
      playlist: { type: "string", multiple: true },
      manifest: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });

  requireOption(values.db, "--db <path>");
  if (!values.playlist || values.playlist.length === 0) {
    throw new LinkError("At least one --playlist <path-or-id> is required.", "BAD_ARGS");
  }

  const apiUrl = resolveApiUrl(values["api-url"]);
  // A dry run makes no network calls, so it does not need a key.
  const apiKey = values["dry-run"] ? "" : resolveApiKey(values["api-key"]);

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
  const out = (s) => process.stdout.write(`${s}\n`);
  const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;

  if (outcome.status === "dry-run") {
    out(
      `[dry-run] ${outcome.trackCount} track(s), ${outcome.playlistCount} playlist(s), ~${mb(outcome.sizeBytes)}`
    );
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

  out(
    `Synced ${outcome.trackCount} track(s) from ${outcome.playlistCount} playlist(s) (~${mb(outcome.sizeBytes)}).`
  );
  out(`Catalogue source set to engine-dj. Manifest: ${manifestPath}`);
}

function requireOption(value, name) {
  if (!value) {
    throw new LinkError(`Missing required option ${name}.`, "BAD_ARGS");
  }
}

async function main(argv = process.argv) {
  try {
    await run(argv);
  } catch (err) {
    if (err instanceof LinkError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

module.exports = { run, main, HELP };
