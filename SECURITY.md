# Security

`djrequest-link` holds a DJRequest.me Developer API key and reads your Engine DJ
library, so it is built to a few hard rules:

- **The API key is stored only in the OS keychain** (`auth set-key`). It is
  never written to a file or log, and never passed to a helper program on
  its command line.
- **The API key is only ever sent over HTTPS** (plain `http://` is allowed for
  `localhost` development only). It is never sent to the signed storage upload
  URL, and redirects are never followed with it.
- **StagelinQ traffic is treated as untrusted.** Only peers on the laptop's own
  subnets are accepted, all input is bounds-checked, and no listening TCP ports
  are opened.
- **Your Engine DJ `m.db` is opened strictly read-only.** It is never modified
  and never uploaded — only a normalized list of the tracks in the playlists you
  choose is sent.
- **No telemetry, analytics, or crash reporting.** Nothing is sent anywhere
  except the DJRequest.me API you configure.
- **Zero runtime dependencies.** Everything uses the Node.js standard library.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's
"Report a vulnerability" button on this repository's Security tab.

## If you leak your API key

Regenerate it from the Developer page in your DJRequest.me admin. The old key
stops working immediately.
