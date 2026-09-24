"use strict";

/**
 * Tracks per-deck state from StagelinQ values and decides which track is
 * "now playing" to the room. Pure logic — the clock is passed in — so every
 * heuristic here is unit-testable without hardware.
 *
 * Several decks report state at once (a DJ cues the next track in headphones,
 * blends two tracks, leaves a finished track loaded). Strategies:
 *
 *   auto (default)  Among decks whose track has been *heard* — playing with
 *                   the channel fader up (or fader position unknown) — for at
 *                   least `minPlaySeconds`, pick the one heard most recently.
 *                   Time spent cueing in headphones doesn't count, so during
 *                   a blend the incoming track takes over only once it has
 *                   been in the mix long enough.
 *   master          The playing deck that is sync/tempo master.
 *   deck:N          Always deck N (N = 1–4), whenever it is playing.
 */

const DECK_PATH = /^\/Engine\/Deck([1-4])\/(Play|PlayState|DeckIsMaster|ExternalMixerVolume|Track\/SongLoaded|Track\/SongName|Track\/ArtistName)$/;
const FADER_PATH = /^\/Mixer\/CH([1-4])faderPosition$/;

const DEFAULTS = { mode: "auto", minPlaySeconds: 10, faderThreshold: 0.05 };

function parseMode(raw = "auto") {
  const value = String(raw).trim().toLowerCase();
  if (value === "auto" || value === "master") return { mode: value };
  const m = /^deck:?([1-4])$/.exec(value);
  if (m) return { mode: "deck", deck: Number(m[1]) };
  throw new Error(`Unknown --mode "${raw}". Use auto, master, or deck:1 … deck:4.`);
}

// StagelinQ values are small JSON objects: {state: bool}, {string: str}, {value: num}.
const asBool = (v) => (typeof v.state === "boolean" ? v.state : undefined);
const asString = (v) => (typeof v.string === "string" ? v.string : undefined);
const asNumber = (v) => (typeof v.value === "number" && Number.isFinite(v.value) ? v.value : undefined);

class DeckTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.decks = new Map(); // "deviceId/N" → deck state
    this.faders = new Map(); // "deviceId/N" → mixer channel fader 0..1
  }

  deck(deviceId, n) {
    const key = `${deviceId}/${n}`;
    let d = this.decks.get(key);
    if (!d) {
      d = {
        key,
        deviceId,
        number: n,
        play: undefined,
        playState: undefined,
        playStartedAt: null,
        heardSince: null,
        isMaster: false,
        volume: undefined,
        loaded: undefined,
        title: "",
        artist: "",
      };
      this.decks.set(key, d);
    }
    return d;
  }

  /** Apply one StagelinQ value. Returns true if it could change the selection. */
  apply(deviceId, name, value, now) {
    const fader = FADER_PATH.exec(name);
    if (fader) {
      const v = asNumber(value);
      if (v === undefined) return false;
      this.faders.set(`${deviceId}/${fader[1]}`, v);
      const d = this.decks.get(`${deviceId}/${fader[1]}`);
      if (d) this.refreshHeard(d, now);
      return true;
    }

    const m = DECK_PATH.exec(name);
    if (!m) return false;
    const d = this.deck(deviceId, Number(m[1]));
    const wasPlaying = isPlaying(d);

    switch (m[2]) {
      case "Play":
        d.play = asBool(value);
        break;
      case "PlayState":
        d.playState = asBool(value);
        break;
      case "DeckIsMaster":
        d.isMaster = asBool(value) === true;
        break;
      case "ExternalMixerVolume":
        d.volume = asNumber(value);
        break;
      case "Track/SongLoaded":
        d.loaded = asBool(value);
        if (d.loaded === false) {
          d.title = "";
          d.artist = "";
        }
        break;
      case "Track/SongName": {
        const title = (asString(value) || "").trim();
        if (title !== d.title) {
          d.title = title;
          // A new track on a deck that is already rolling starts its clocks now.
          if (isPlaying(d)) d.playStartedAt = now;
          d.heardSince = null;
        }
        break;
      }
      case "Track/ArtistName":
        d.artist = (asString(value) || "").trim();
        break;
    }

    const playing = isPlaying(d);
    if (playing && !wasPlaying) d.playStartedAt = now;
    if (!playing) d.playStartedAt = null;
    this.refreshHeard(d, now);
    return true;
  }

  /**
   * `heardSince` is when the deck's current track became audible to the room
   * (playing with the fader up). Cueing in headphones doesn't count, so a
   * track only takes over once it has been *heard* for minPlaySeconds.
   */
  refreshHeard(d, now) {
    const heard = isPlaying(d) && this.isAudible(d);
    if (!heard) d.heardSince = null;
    else if (d.heardSince === null) d.heardSince = now;
  }

  /** Forget everything from a device that disconnected. */
  forgetDevice(deviceId) {
    for (const key of [...this.decks.keys()]) if (key.startsWith(`${deviceId}/`)) this.decks.delete(key);
    for (const key of [...this.faders.keys()]) if (key.startsWith(`${deviceId}/`)) this.faders.delete(key);
  }

  /** Fader position for a deck: the deck's own mixer volume, else the same-numbered channel. */
  faderFor(d) {
    if (d.volume !== undefined) return d.volume;
    return this.faders.get(`${d.deviceId}/${d.number}`);
  }

  isAudible(d) {
    const fader = this.faderFor(d);
    return fader === undefined || fader > this.options.faderThreshold;
  }

  /**
   * @returns {{ deck: string, title: string, artist: string } | null}
   */
  select(now) {
    const { mode, deck, minPlaySeconds } = this.options;
    const minMs = minPlaySeconds * 1000;
    const live = [...this.decks.values()].filter((d) => isPlaying(d) && d.title);
    let candidates;

    if (mode === "deck") {
      candidates = live.filter((d) => d.number === deck);
    } else if (mode === "master") {
      candidates = live.filter((d) => d.isMaster);
    } else {
      candidates = live.filter((d) => d.heardSince !== null && now - d.heardSince >= minMs);
    }
    if (candidates.length === 0) return null;

    // Most recently heard (auto) / started (master, deck) wins.
    const since = (d) => (mode === "auto" ? d.heardSince : d.playStartedAt) ?? 0;
    candidates.sort((a, b) => since(b) - since(a) || a.key.localeCompare(b.key));
    const pick = candidates[0];
    return { deck: pick.key, title: pick.title, artist: pick.artist };
  }

  /** Milliseconds until a deck could newly qualify in auto mode (for re-checking). */
  nextQualifyIn(now) {
    if (this.options.mode !== "auto") return null;
    const minMs = this.options.minPlaySeconds * 1000;
    let soonest = null;
    for (const d of this.decks.values()) {
      if (!d.title || d.heardSince === null) continue;
      const wait = d.heardSince + minMs - now;
      if (wait > 0 && (soonest === null || wait < soonest)) soonest = wait;
    }
    return soonest;
  }

  /** Snapshot for --verbose / diagnostics. */
  describe(now) {
    return [...this.decks.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((d) => ({
        deck: d.key,
        playing: isPlaying(d),
        playingFor: d.playStartedAt === null ? null : Math.round((now - d.playStartedAt) / 1000),
        heardFor: d.heardSince === null ? null : Math.round((now - d.heardSince) / 1000),
        fader: this.faderFor(d),
        master: d.isMaster,
        title: d.title,
        artist: d.artist,
      }));
  }
}

// PlayState is "actually producing audio"; fall back to the Play button state
// on firmware that doesn't send it.
function isPlaying(d) {
  if (d.loaded === false) return false;
  return (d.playState ?? d.play) === true;
}

module.exports = { DeckTracker, parseMode, DEFAULTS };
