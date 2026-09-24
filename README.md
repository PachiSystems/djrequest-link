# djrequest-link

Local companion tool for [DJRequest.me](https://www.djrequest.me). Runs on your
own laptop.

- **Now Playing:** follows your Denon DJ / Engine DJ gear over StagelinQ and
  shows the track you're playing on your venue's live display.
- **Catalogue sync:** reads your Engine DJ library read-only and uploads the
  playlists you choose as your requestable catalogue.

**Documentation: <https://pachisystems.github.io/djrequest-link/>**

## Quick start

Requires **Node.js 24+**. There are no dependencies.

```sh
npm install -g github:PachiSystems/djrequest-link

djrequest-link auth set-key          # store your API key in the OS keychain
djrequest-link venues list           # find your venue id
djrequest-link now-playing watch --dry-run            # check deck detection
djrequest-link now-playing watch --venue <venue-id>   # go live
```

Sync Engine DJ playlists as your catalogue:

```sh
djrequest-link catalogue list-playlists --db "/path/to/Engine Library/Database2/m.db"
djrequest-link catalogue sync --db "/path/to/m.db" --playlist "House/Deep" --playlist "Top 100"
```

Run `djrequest-link --help`, or see the
[command reference](https://pachisystems.github.io/djrequest-link/reference.html).

## Security

- Your API key is stored only in the OS keychain (macOS Keychain, Windows
  Credential Manager, Linux Secret Service). It is only sent over HTTPS, and
  never to a redirect target.
- Your Engine DJ `m.db` is opened read-only and is never uploaded.
- There is no telemetry and no third-party code.

See [SECURITY.md](SECURITY.md) and the
[security page](https://pachisystems.github.io/djrequest-link/security.html).

## Development

```sh
npm test        # node --test; synthetic fixtures and a fake StagelinQ device
npm run lint    # syntax check
npm run check   # blocks committed databases, exports, keys, real paths, bidi chars
```

To test Now Playing without hardware, run a fake two-deck player on your LAN
in one terminal and a dry-run watcher in another:

```sh
node scripts/simulate-device.js
node bin/djrequest-link.js now-playing watch --dry-run --min-play 5
```

Never commit a real `m.db`, a library export, or an API key. CI runs
`npm run check` on every push.

The docs site is the static HTML in [`docs/`](docs/). It is published to
GitHub Pages by `.github/workflows/pages.yml`.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for personal and other
non-commercial use. For commercial use, contact the author. The protocol
references are acknowledged in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
