"use strict";

/**
 * Pushes the selected track to a venue's Now Playing, within the API's
 * constraints:
 *
 *   - The API rate limit is 60 writes/min per DJ (shared with reads), so we
 *     only write on an actual change of (title, artist), and never more often
 *     than `minWriteIntervalMs`. Changes inside that window coalesce: only
 *     the latest is sent.
 *   - Nothing on the server expires a Now Playing entry. So when nothing is
 *     playing for `idleClearMs` (gear off, laptop asleep, DJ finished), and on
 *     shutdown, we DELETE it — but only if we are the ones who set it.
 *   - Everything sent is sanitized and length-bounded: it comes off the LAN.
 *
 * `api` is null in dry-run mode: decisions are reported via `log` only.
 */

const MAX_FIELD_CHARS = 200;
const DEFAULTS = {
  minWriteIntervalMs: 5_000,
  idleClearMs: 3 * 60_000,
  retryBaseMs: 5_000,
  retryMaxMs: 60_000,
  rateLimitDefaultMs: 60_000,
};

// Codes where retrying cannot help; the bridge stops and reports.
const FATAL_CODES = new Set(["API_AUTH", "API_FORBIDDEN", "API_NOT_FOUND", "API_REDIRECT", "INSECURE_URL"]);

// C0/C1 controls, zero-width and bidi-override characters, BOM. Built from code
// points so the source stays ASCII.
const UNSAFE_CHARS = new RegExp(
  `[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
    .join("")}]`,
  "g"
);

/** Strip control characters, collapse whitespace, cap length (by code point). */
function cleanField(value) {
  const text = String(value ?? "")
    .replace(UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length > MAX_FIELD_CHARS ? `${chars.slice(0, MAX_FIELD_CHARS - 1).join("")}…` : text;
}

/** Selection → API payload, or null when there is no usable title. */
function toPayload(selection) {
  if (!selection) return null;
  const trackTitle = cleanField(selection.title);
  if (!trackTitle) return null;
  return { trackTitle, trackArtist: cleanField(selection.artist) || "Unknown Artist" };
}

const samePayload = (a, b) =>
  a === b || (!!a && !!b && a.trackTitle === b.trackTitle && a.trackArtist === b.trackArtist);

class NowPlayingBridge {
  /**
   * @param {object} o
   * @param {object|null} o.api        api client (setNowPlaying / clearNowPlaying), or null for dry-run
   * @param {string} [o.venueId]
   * @param {(event: object) => void} [o.log]
   * @param {(err: Error) => void} [o.onFatal]
   */
  constructor({ api, venueId, log = () => {}, onFatal = () => {}, now = Date.now, ...options }) {
    this.api = api;
    this.venueId = venueId;
    this.log = log;
    this.onFatal = onFatal;
    this.now = now;
    this.o = { ...DEFAULTS, ...options };

    this.desired = null; // what should be on the display
    this.shown = null; // what we last successfully wrote (null = nothing of ours)
    this.idleSince = null;
    this.lastWriteAt = -Infinity;
    this.blockedUntil = 0;
    this.failures = 0;
    this.timer = null;
    this.inFlight = null;
    this.stopped = false;
  }

  /** Feed the current selection (call on every state change; cheap when unchanged). */
  update(selection) {
    if (this.stopped) return;
    const payload = toPayload(selection);
    const now = this.now();

    if (payload) this.idleSince = null;
    else if (this.idleSince === null) this.idleSince = now;

    if (!samePayload(payload, this.desired)) {
      if (payload) this.log({ type: "selected", ...payload, deck: selection.deck });
      else this.log({ type: "nothing-playing" });
    }
    // While idle, keep showing the last track until the idle timeout passes.
    if (payload) this.desired = payload;
    this.schedule();
  }

  /** Re-evaluate timers (idle clear). Call periodically. */
  tick() {
    this.schedule();
  }

  /**
   * The display may be stale after the process was suspended (laptop sleep):
   * clear it now rather than waiting out the idle timeout.
   */
  resumedFromSleep() {
    this.log({ type: "resumed-from-sleep" });
    this.desired = null;
    this.idleSince = this.now() - this.o.idleClearMs;
    this.schedule();
  }

  schedule() {
    if (this.stopped || this.inFlight) return;
    clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();

    const idleExpired = this.idleSince !== null && now - this.idleSince >= this.o.idleClearMs;
    const target = idleExpired ? null : this.desired;
    if (idleExpired) this.desired = null;
    if (samePayload(target, this.shown)) {
      // Nothing to write yet; wake up when the idle timeout would clear it.
      if (this.shown && this.idleSince !== null) this.wakeIn(this.idleSince + this.o.idleClearMs - now);
      return;
    }

    const wait = Math.max(this.blockedUntil - now, this.lastWriteAt + this.o.minWriteIntervalMs - now, 0);
    if (wait > 0) {
      this.wakeIn(wait);
      return;
    }
    this.inFlight = this.write(target).finally(() => {
      this.inFlight = null;
      this.schedule();
    });
  }

  wakeIn(ms) {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, Math.max(0, ms));
    this.timer.unref?.();
  }

  async write(target) {
    this.lastWriteAt = this.now();
    try {
      if (target) {
        if (this.api) await this.api.setNowPlaying(this.venueId, target);
        this.log({ type: this.api ? "pushed" : "would-push", ...target });
      } else {
        if (this.api) await this.api.clearNowPlaying(this.venueId);
        this.log({ type: this.api ? "cleared" : "would-clear" });
      }
      this.shown = target;
      this.failures = 0;
    } catch (err) {
      this.handleError(err);
    }
  }

  handleError(err) {
    if (FATAL_CODES.has(err.code)) {
      this.stopped = true;
      this.log({ type: "fatal", message: err.message });
      this.onFatal(err);
      return;
    }
    this.failures += 1;
    const backoff =
      err.code === "API_RATE_LIMITED"
        ? err.retryAfterMs ?? this.o.rateLimitDefaultMs
        : Math.min(this.o.retryMaxMs, this.o.retryBaseMs * 2 ** (this.failures - 1));
    this.blockedUntil = this.now() + backoff;
    this.log({ type: "retrying", message: err.message, inMs: backoff });
  }

  /**
   * Stop and clear the display if we put something on it. Bounded by
   * `timeoutMs` so a dead network can't hang shutdown.
   */
  async shutdown({ timeoutMs = 5_000 } = {}) {
    const wasStopped = this.stopped;
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.inFlight) await this.inFlight.catch(() => {});
    if (!this.shown || wasStopped) return;
    if (!this.api) {
      this.log({ type: "would-clear" });
      return;
    }
    let timer;
    try {
      await Promise.race([
        this.api.clearNowPlaying(this.venueId),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
        }),
      ]);
      this.shown = null;
      this.log({ type: "cleared" });
    } catch (err) {
      this.log({ type: "clear-failed", message: err.message });
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { NowPlayingBridge, cleanField, toPayload, MAX_FIELD_CHARS, DEFAULTS };
