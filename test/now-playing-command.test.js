"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { preflight } = require("../src/commands/now-playing");
const { run } = require("../src/cli");

process.env.DJREQUEST_NO_KEYCHAIN = "1";

const apiWith = (venue) => ({ getVenue: async () => venue });

test("preflight refuses a venue whose live display is off", async () => {
  await assert.rejects(
    preflight(apiWith({ name: "The Club", liveDisplayEnabled: false, isActive: true }), "v1"),
    (err) => {
      assert.equal(err.code, "LIVE_DISPLAY_OFF");
      assert.match(err.message, /live display is turned off for "The Club"/);
      return true;
    }
  );
});

test("preflight treats a missing flag as off (fail safe)", async () => {
  await assert.rejects(preflight(apiWith({ name: "Old API" }), "v1"), /turned off/);
});

test("preflight passes a live venue through", async () => {
  const venue = { name: "The Club", liveDisplayEnabled: true, isActive: true };
  assert.equal(await preflight(apiWith(venue), "v1"), venue);
});

test("watch validates its options before touching the network", async () => {
  await assert.rejects(run(["node", "cli", "now-playing", "watch", "--dry-run", "--mode", "deck:9"]), /Unknown --mode/);
  await assert.rejects(
    run(["node", "cli", "now-playing", "watch", "--dry-run", "--fader-threshold", "2"]),
    /between 0 and 1/
  );
  const saved = process.env.DJREQUEST_VENUE_ID;
  delete process.env.DJREQUEST_VENUE_ID;
  try {
    await assert.rejects(run(["node", "cli", "now-playing", "watch"]), /Missing venue/);
  } finally {
    if (saved !== undefined) process.env.DJREQUEST_VENUE_ID = saved;
  }
});

test("set requires a title", async () => {
  await assert.rejects(run(["node", "cli", "now-playing", "set", "--venue", "v1"]), /--title/);
});
