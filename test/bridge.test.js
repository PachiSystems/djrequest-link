"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { NowPlayingBridge, cleanField, toPayload } = require("../src/nowplaying/bridge");
const { LinkError } = require("../src/errors");

const flush = () => new Promise((r) => setImmediate(r));

/** Fake API recording calls; `fail` can be set to make the next call throw. */
function fakeApi() {
  const calls = [];
  const api = {
    calls,
    fail: null,
    async setNowPlaying(venueId, body) {
      calls.push(["PUT", venueId, body.trackTitle, body.trackArtist]);
      if (api.fail) {
        const e = api.fail;
        api.fail = null;
        throw e;
      }
    },
    async clearNowPlaying(venueId) {
      calls.push(["DELETE", venueId]);
    },
  };
  return api;
}

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const api = fakeApi();
  const events = [];
  const fatal = [];
  const bridge = new NowPlayingBridge({
    api,
    venueId: "v1",
    log: (e) => events.push(e),
    onFatal: (e) => fatal.push(e),
    minWriteIntervalMs: 5_000,
    idleClearMs: 60_000,
    ...options,
  });
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
    await flush();
  };
  return { api, bridge, events, fatal, advance };
}

const sel = (title, artist = "Artist") => ({ deck: "d/1", title, artist });

test("cleanField strips control/bidi chars, collapses whitespace, caps length", () => {
  assert.equal(cleanField("  Song\n\tA\u202e  "), "Song A");
  assert.equal(cleanField("x".repeat(500)).length, 200);
  assert.equal([...cleanField("😀".repeat(300))].length, 200);
  assert.equal(cleanField(null), "");
});

test("toPayload requires a title and defaults the artist", () => {
  assert.equal(toPayload(null), null);
  assert.equal(toPayload(sel("   ")), null);
  assert.deepEqual(toPayload(sel("T", "")), { trackTitle: "T", trackArtist: "Unknown Artist" });
});

test("pushes once per change, never repeats the same track", async (t) => {
  const { api, bridge, advance } = setup(t);
  bridge.update(sel("Song A"));
  await advance(0);
  bridge.update(sel("Song A"));
  bridge.update(sel("Song A"));
  await advance(10_000);
  assert.deepEqual(api.calls, [["PUT", "v1", "Song A", "Artist"]]);
});

test("rapid changes coalesce: only the latest is sent after the write interval", async (t) => {
  const { api, bridge, advance } = setup(t);
  bridge.update(sel("Song A"));
  await advance(0);
  bridge.update(sel("Song B"));
  bridge.update(sel("Song C"));
  await advance(4_000);
  assert.equal(api.calls.length, 1, "still inside the 5 s window");
  await advance(1_000);
  assert.deepEqual(api.calls.map((c) => c[2]), ["Song A", "Song C"]);
});

test("a 429 waits for Retry-After, then sends the latest track", async (t) => {
  const { api, bridge, advance, events } = setup(t);
  api.fail = Object.assign(new LinkError("rate limited", "API_RATE_LIMITED"), { retryAfterMs: 20_000 });
  bridge.update(sel("Song A"));
  await advance(0);
  bridge.update(sel("Song B"));
  await advance(19_000);
  assert.equal(api.calls.length, 1);
  await advance(1_000);
  assert.deepEqual(api.calls.map((c) => c[2]), ["Song A", "Song B"]);
  assert.ok(events.some((e) => e.type === "retrying" && e.inMs === 20_000));
});

test("network errors back off exponentially", async (t) => {
  const { api, bridge, advance, events } = setup(t, { retryBaseMs: 1_000 });
  api.fail = new LinkError("down", "NETWORK");
  bridge.update(sel("Song A"));
  await advance(0);
  assert.equal(api.calls.length, 1);
  await advance(5_000); // write interval (5 s) dominates the 1 s backoff
  assert.equal(api.calls.length, 2);
  assert.deepEqual(events.filter((e) => e.type === "pushed").map((e) => e.trackTitle), ["Song A"]);
});

test("auth / venue errors are fatal: stop and report, no retries", async (t) => {
  const { api, bridge, advance, fatal } = setup(t);
  api.fail = new LinkError("API request forbidden (403)", "API_FORBIDDEN");
  bridge.update(sel("Song A"));
  await advance(0);
  bridge.update(sel("Song B"));
  await advance(60_000);
  assert.equal(api.calls.length, 1);
  assert.equal(fatal.length, 1);
});

test("nothing playing for idleClearMs → DELETE (keeps the last track until then)", async (t) => {
  const { api, bridge, advance } = setup(t);
  bridge.update(sel("Song A"));
  await advance(0);
  bridge.update(null);
  await advance(59_000);
  assert.deepEqual(api.calls.map((c) => c[0]), ["PUT"]);
  await advance(1_000);
  assert.deepEqual(api.calls.map((c) => c[0]), ["PUT", "DELETE"]);
});

test("a track resuming before the idle timeout cancels the clear", async (t) => {
  const { api, bridge, advance } = setup(t);
  bridge.update(sel("Song A"));
  await advance(0);
  bridge.update(null);
  await advance(30_000);
  bridge.update(sel("Song A"));
  await advance(120_000);
  assert.deepEqual(api.calls.map((c) => c[0]), ["PUT"]);
});

test("resumedFromSleep clears immediately", async (t) => {
  const { api, bridge, advance } = setup(t);
  bridge.update(sel("Song A"));
  await advance(5_000);
  bridge.resumedFromSleep();
  await advance(0);
  assert.deepEqual(api.calls.map((c) => c[0]), ["PUT", "DELETE"]);
});

test("shutdown never deletes an entry we didn't set", async (t) => {
  const { api, bridge } = setup(t);
  await bridge.shutdown();
  assert.equal(api.calls.length, 0);
});

test("shutdown clears the track we set", async (t) => {
  const { api, bridge, advance } = setup(t);
  bridge.update(sel("Song A"));
  await advance(0);
  await bridge.shutdown();
  assert.deepEqual(api.calls.map((c) => c[0]), ["PUT", "DELETE"]);
});

test("dry-run (api = null) logs decisions and makes no calls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const events = [];
  const bridge = new NowPlayingBridge({ api: null, log: (e) => events.push(e), idleClearMs: 1_000 });
  bridge.update(sel("Song A"));
  await flush();
  bridge.update(null);
  t.mock.timers.tick(6_000);
  await flush();
  await flush();
  assert.deepEqual(
    events.map((e) => e.type),
    ["selected", "would-push", "nothing-playing", "would-clear"]
  );
});
