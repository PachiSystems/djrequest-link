"use strict";

const { LinkError } = require("../errors");
const { StagelinqClient } = require("../nowplaying/stagelinq");
const { DeckTracker, parseMode, DEFAULTS: SELECT_DEFAULTS } = require("../nowplaying/deck-selector");
const { NowPlayingBridge, toPayload, DEFAULTS: BRIDGE_DEFAULTS } = require("../nowplaying/bridge");
const { API_OPTIONS, ENV_VENUE_ID, out, warn, parse, requireOption, apiFromOptions, venueFromOptions } = require("./shared");
const { version } = require("../../package.json");

const HELP = `djrequest-link now-playing — show the track you're playing on your venue's live display.

Usage:
  djrequest-link now-playing watch   [--venue <id>] [--dry-run] [--mode <m>] [options]
  djrequest-link now-playing devices [--seconds <n>] [--interface <ip>]
  djrequest-link now-playing show    [--venue <id>]
  djrequest-link now-playing set     [--venue <id>] --title <t> --artist <a>
  djrequest-link now-playing clear   [--venue <id>]

Commands:
  watch     Follow your Denon / Engine DJ gear over StagelinQ and update Now
            Playing whenever the track changes. Clears the display when you
            stop (Ctrl+C) or nothing has played for a while.
  devices   List StagelinQ devices found on the network, then exit.
  show / set / clear
            Read, set or clear Now Playing by hand — handy for testing the
            live display without any gear.

Options:
  --venue <id>             Venue to update (or set ${ENV_VENUE_ID}).
                           Find it with \`djrequest-link venues list\`.
  --dry-run                (watch) Print what would be sent; send nothing. Needs
                           no API key or venue — use it to check deck detection.
  --mode <m>               (watch) Which deck counts as playing:
                             auto     (default) the audible deck most recently
                                      started, once it has played --min-play s
                             master   the deck that is tempo/sync master
                             deck:N   always deck N (1–4)
  --min-play <seconds>     (watch, auto) Seconds a track must play before it
                           counts (default ${SELECT_DEFAULTS.minPlaySeconds}).
  --fader-threshold <0–1>  (watch, auto) Fader position below which a deck is
                           treated as silent (default ${SELECT_DEFAULTS.faderThreshold}).
  --idle-clear <minutes>   (watch) Clear the display after this long with
                           nothing playing (default ${BRIDGE_DEFAULTS.idleClearMs / 60000}).
  --interface <ip>         Only use the network interface with this IPv4 address.
  --verbose                (watch) Also print device and deck details.
  --seconds <n>            (devices) How long to listen (default 5).
  --api-url, --api-key     See \`djrequest-link --help\`.
`;

const SLEEP_GAP_MS = 60_000;
const TICK_MS = 5_000;
const NO_DEVICE_HINT_MS = 15_000;

const stamp = () => new Date().toLocaleTimeString([], { hour12: false });
const log = (s) => out(`[${stamp()}] ${s}`);

function number(value, name, { min, max }) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new LinkError(`${name} must be a number between ${min} and ${max}.`, "BAD_ARGS");
  }
  return n;
}

/**
 * Refuse to run against a venue whose live display is off: writes would
 * succeed (HTTP 200) but nothing would ever be visible.
 */
async function preflight(api, venueId) {
  const venue = await api.getVenue(venueId);
  if (venue.liveDisplayEnabled !== true) {
    throw new LinkError(
      `The live display is turned off for "${venue.name}". Now Playing is only shown on the ` +
        "live display: turn it on in the venue's settings in your DJRequest.me admin, then run this again.",
      "LIVE_DISPLAY_OFF"
    );
  }
  if (venue.isActive === false) warn(`Venue "${venue.name}" is not active.`);
  return venue;
}

const NOT_VISIBLE_HINT =
  "If nothing appears on the live display, check that your plan includes Now Playing — " +
  "the API accepts updates either way, but the display only shows them with that feature.";

async function watch(args) {
  const values = parse(args, {
    ...API_OPTIONS,
    venue: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    mode: { type: "string", default: "auto" },
    "min-play": { type: "string" },
    "fader-threshold": { type: "string" },
    "idle-clear": { type: "string" },
    interface: { type: "string" },
    verbose: { type: "boolean", default: false },
  });

  let mode;
  try {
    mode = parseMode(values.mode);
  } catch (err) {
    throw new LinkError(err.message, "BAD_ARGS");
  }
  const minPlaySeconds = number(values["min-play"], "--min-play", { min: 0, max: 600 }) ?? SELECT_DEFAULTS.minPlaySeconds;
  const faderThreshold =
    number(values["fader-threshold"], "--fader-threshold", { min: 0, max: 1 }) ?? SELECT_DEFAULTS.faderThreshold;
  const idleMinutes = number(values["idle-clear"], "--idle-clear", { min: 1, max: 24 * 60 });
  const dryRun = values["dry-run"];
  const verbose = values.verbose;

  let api = null;
  let venueId;
  if (!dryRun) {
    venueId = venueFromOptions(values);
    ({ api } = apiFromOptions(values));
    const venue = await preflight(api, venueId);
    log(`Venue: ${venue.name} — live display is on.`);
  } else {
    log("Dry run: nothing will be sent to DJRequest.me.");
  }

  const tracker = new DeckTracker({ ...mode, minPlaySeconds, faderThreshold });
  const deviceNames = new Map();
  let fatal = null;
  let hinted = false;
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });

  const bridge = new NowPlayingBridge({
    api,
    venueId,
    ...(idleMinutes ? { idleClearMs: idleMinutes * 60_000 } : {}),
    onFatal: (err) => {
      fatal = err;
      stop();
    },
    log: (e) => {
      switch (e.type) {
        case "selected":
          if (verbose) log(`Selected ${describeDeck(e.deck)}: ${e.trackTitle} — ${e.trackArtist}`);
          break;
        case "pushed":
          log(`Now playing: ${e.trackTitle} — ${e.trackArtist}`);
          if (!hinted) {
            hinted = true;
            log(NOT_VISIBLE_HINT);
          }
          break;
        case "would-push":
          log(`[dry-run] Now playing: ${e.trackTitle} — ${e.trackArtist}`);
          break;
        case "cleared":
          log("Cleared Now Playing.");
          break;
        case "would-clear":
          log("[dry-run] Would clear Now Playing.");
          break;
        case "nothing-playing":
          if (verbose) log("Nothing playing.");
          break;
        case "retrying":
          log(`Update failed (${e.message}); retrying in ${Math.round(e.inMs / 1000)} s.`);
          break;
        case "resumed-from-sleep":
          log("Woke from sleep — clearing Now Playing until a track is confirmed again.");
          break;
        case "clear-failed":
          warn(`Could not clear Now Playing on exit (${e.message}). Clear it with \`now-playing clear\`.`);
          break;
      }
    },
  });

  function describeDeck(key) {
    const [deviceId, n] = String(key).split("/");
    const name = deviceNames.get(deviceId);
    return name ? `${name} deck ${n}` : `deck ${n}`;
  }

  let qualifyTimer = null;
  function reevaluate() {
    const now = Date.now();
    bridge.update(tracker.select(now));
    clearTimeout(qualifyTimer);
    const wait = tracker.nextQualifyIn(now);
    if (wait !== null) qualifyTimer = setTimeout(reevaluate, wait + 50);
  }

  const client = new StagelinqClient({ interfaceAddress: values.interface, softwareVersion: version });
  client.on("state", ({ deviceId, name, value }) => {
    if (tracker.apply(deviceId, name, value, Date.now())) reevaluate();
  });
  client.on("device-connected", (d) => {
    deviceNames.set(d.id, d.name);
    log(`Connected to ${d.name} (${d.software} ${d.version}) at ${d.address}.`);
  });
  let stopping = false;
  client.on("device-disconnected", ({ device, reason }) => {
    if (stopping) return;
    log(`Lost ${device.name}: ${reason}.`);
    tracker.forgetDevice(device.id);
    reevaluate();
  });
  client.on("error", (err) => {
    fatal = new LinkError(`StagelinQ network error: ${err.message}`, "NETWORK");
    stop();
  });

  try {
    await client.start();
  } catch (err) {
    throw new LinkError(
      `Could not listen for StagelinQ devices on UDP port 51337 (${err.code || err.message}).`,
      "NETWORK"
    );
  }
  log("Listening for StagelinQ devices… (Ctrl+C to stop)");

  let lastTick = Date.now();
  const ticker = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > SLEEP_GAP_MS) bridge.resumedFromSleep();
    lastTick = now;
    bridge.tick();
    if (verbose) for (const d of tracker.describe(now)) if (d.playing) log(`  ${formatDeck(d)}`);
  }, TICK_MS);

  const noDevices = setTimeout(() => {
    if (client.connections.size === 0) {
      log(
        "No StagelinQ devices yet. Check the laptop is on the same network as your gear, and that your " +
          "firewall allows incoming UDP on port 51337 (Windows asks the first time you run this)."
      );
    }
  }, NO_DEVICE_HINT_MS);

  const onSignal = () => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  await stopped;
  stopping = true;

  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  clearInterval(ticker);
  clearTimeout(noDevices);
  clearTimeout(qualifyTimer);
  log("Stopping…");
  await bridge.shutdown();
  await client.stop();
  if (fatal) throw fatal instanceof LinkError ? fatal : new LinkError(fatal.message, "ERROR");
}

function formatDeck(d) {
  const fader = d.fader === undefined ? "?" : d.fader.toFixed(2);
  const heard = d.heardFor === null ? "not heard" : `heard ${d.heardFor}s`;
  return `${d.deck}: ${d.playing ? `playing ${d.playingFor}s, ${heard}` : "stopped"}, fader ${fader}${d.master ? ", master" : ""} — ${d.title || "(no track)"}`;
}

async function devices(args) {
  const values = parse(args, { seconds: { type: "string" }, interface: { type: "string" } });
  const seconds = number(values.seconds, "--seconds", { min: 1, max: 120 }) ?? 5;
  const client = new StagelinqClient({ interfaceAddress: values.interface, softwareVersion: version });
  const found = new Map();
  client.discovery.on("device", (d) => found.set(d.id, d));
  client.on("device-connected", (d) => {
    found.set(d.id, { ...d, stateMap: true });
  });
  client.on("error", () => {});
  await client.start();
  out(`Listening for ${seconds} s…`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await client.stop();

  if (found.size === 0) {
    out("No StagelinQ devices found. Check the network and that UDP port 51337 is allowed through your firewall.");
    process.exitCode = 1;
    return;
  }
  for (const d of found.values()) {
    out(`${d.address}  ${d.name}  ${d.software} ${d.version}${d.stateMap ? "  (deck state OK)" : ""}`);
  }
}

async function show(args) {
  const values = parse(args, { ...API_OPTIONS, venue: { type: "string" } });
  const venueId = venueFromOptions(values);
  const { api } = apiFromOptions(values);
  const { nowPlaying } = await api.getNowPlaying(venueId);
  if (!nowPlaying) out("Nothing is set as Now Playing.");
  else {
    const since = nowPlaying.startedAt ? ` (since ${new Date(nowPlaying.startedAt).toLocaleTimeString()})` : "";
    out(`${nowPlaying.trackTitle} — ${nowPlaying.trackArtist}${since}`);
  }
}

async function set(args) {
  const values = parse(args, {
    ...API_OPTIONS,
    venue: { type: "string" },
    title: { type: "string" },
    artist: { type: "string" },
  });
  requireOption(values.title, "--title <title>");
  const venueId = venueFromOptions(values);
  const payload = toPayload({ title: values.title, artist: values.artist });
  if (!payload) throw new LinkError("--title must not be empty.", "BAD_ARGS");
  const { api } = apiFromOptions(values);
  await preflight(api, venueId);
  await api.setNowPlaying(venueId, payload);
  out(`Now playing: ${payload.trackTitle} — ${payload.trackArtist}`);
  out(NOT_VISIBLE_HINT);
}

async function clear(args) {
  const values = parse(args, { ...API_OPTIONS, venue: { type: "string" } });
  const venueId = venueFromOptions(values);
  const { api } = apiFromOptions(values);
  await api.clearNowPlaying(venueId);
  out("Cleared Now Playing.");
}

module.exports = { HELP, commands: { watch, devices, show, set, clear }, preflight };
