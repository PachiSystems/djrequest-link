# djrequest-link

Local companion tool for [DJRequest.me](https://djrequest.me). Runs on your own
laptop.

- **Catalogue sync (available now):** reads your Engine DJ library read-only,
  lets you pick playlists, and uploads just those tracks as your requestable
  catalogue.
- **Now Playing (in development):** reads the current track from Denon /
  Engine DJ gear over StagelinQ and shows it on your venue's live display.

See [SECURITY.md](SECURITY.md) for how the tool handles your API key and library.

## Requirements

- **Node.js 24 or newer.** No `npm install` is needed: the tool has zero
  dependencies and uses Node's built-in SQLite.
- A DJRequest.me plan that includes the **Developer API**. Your API key is on the
  Developer page of your admin.

Standalone installers that don't need Node are planned.

## Setup

Set your API key as an environment variable, not as a command-line flag (flags
end up in your shell history):

```sh
# macOS / Linux
export DJREQUEST_API_KEY="your-key"

# Windows PowerShell
$env:DJREQUEST_API_KEY = "your-key"
```

## Catalogue sync (Engine DJ)

### Where is the Engine DJ database?

| OS | Path |
|----|------|
| macOS | `~/Music/Engine Library/Database2/m.db` |
| Windows | `%USERPROFILE%\Music\Engine Library\Database2\m.db` |

If you sync Engine DJ to an external/USB drive, look for
`Engine Library/Database2/m.db` on that drive instead.

> **Close Engine DJ first.** The tool reads a snapshot of the database without
> locking it, so changes Engine DJ hasn't saved yet won't be included. It warns
> you when it detects this.

### Commands

List your playlists:

```sh
node bin/djrequest-link.js catalogue list-playlists --db "/path/to/m.db"
```

Preview a sync without uploading (no API key needed):

```sh
node bin/djrequest-link.js catalogue sync --db "/path/to/m.db" \
  --playlist "House/Deep" --playlist "Top 100" --dry-run
```

Sync for real:

```sh
node bin/djrequest-link.js catalogue sync --db "/path/to/m.db" \
  --playlist "House/Deep" --playlist "Top 100"
```

- **A sync replaces your whole catalogue** with exactly the tracks in the
  playlists you name, so pass every playlist you want requestable in one command.
- `--playlist` accepts a full path (`House/Deep`), a unique title, or a numeric
  id. Tracks that appear in several playlists are only counted once.
- Re-running with the same selection skips the upload if nothing changed. It
  keeps state in `./djrequest-link.manifest.json`, which never contains your API
  key. Use `--force` to upload anyway.
- `catalogue export --out file.json` writes the normalized tracks locally
  without uploading. `catalogue inspect` prints read-only schema diagnostics.

Run `node bin/djrequest-link.js --help` for every option.

### What gets uploaded

Your `m.db` is **never** uploaded or modified. The tool opens it read-only
without creating any files next to it. Only a normalized list of the selected
tracks is sent: title, artist, album, genre, BPM, key (Camelot), length, year,
label and similar fields. Local file paths are not included.

## Development

```sh
npm test        # node --test, synthetic in-memory fixtures only
npm run lint    # syntax check
npm run check   # refuses committed databases, exports, keys, and real paths
```

Never commit a real `m.db`, a library export, or an API key. `.gitignore` and
`npm run check` (which also runs in CI) are there to catch mistakes.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for personal and other
non-commercial use. For commercial use, contact the author.
