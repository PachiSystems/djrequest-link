"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DeckTracker, parseMode } = require("../src/nowplaying/deck-selector");

const DEV = "dev1";
const S = 1000;

/** Drive a tracker with readable helpers. */
function rig(options) {
  const t = new DeckTracker(options);
  let now = 0;
  const api = {
    t,
    at(seconds) {
      now = seconds * S;
      return api;
    },
    load(deck, title, artist) {
      t.apply(DEV, `/Engine/Deck${deck}/Track/SongLoaded`, { state: true }, now);
      t.apply(DEV, `/Engine/Deck${deck}/Track/SongName`, { string: title }, now);
      t.apply(DEV, `/Engine/Deck${deck}/Track/ArtistName`, { string: artist }, now);
      return api;
    },
    play(deck, on = true) {
      t.apply(DEV, `/Engine/Deck${deck}/PlayState`, { state: on }, now);
      return api;
    },
    fader(deck, value) {
      t.apply(DEV, `/Engine/Deck${deck}/ExternalMixerVolume`, { value }, now);
      return api;
    },
    master(deck, on = true) {
      t.apply(DEV, `/Engine/Deck${deck}/DeckIsMaster`, { state: on }, now);
      return api;
    },
    pick() {
      const s = t.select(now);
      return s && `${s.title} / ${s.artist}`;
    },
  };
  return api;
}

test("parseMode accepts auto, master, deck:N", () => {
  assert.deepEqual(parseMode("auto"), { mode: "auto" });
  assert.deepEqual(parseMode("MASTER"), { mode: "master" });
  assert.deepEqual(parseMode("deck:3"), { mode: "deck", deck: 3 });
  assert.deepEqual(parseMode("deck2"), { mode: "deck", deck: 2 });
  assert.throws(() => parseMode("deck:5"), /Unknown --mode/);
});

test("auto: a track only counts after playing for minPlaySeconds", () => {
  const r = rig({ minPlaySeconds: 10 }).at(0).load(1, "Song A", "Artist A").play(1);
  assert.equal(r.at(9).pick(), null);
  assert.equal(r.at(10).pick(), "Song A / Artist A");
});

test("auto: cueing in headphones with the fader down never counts", () => {
  const r = rig({ minPlaySeconds: 10 })
    .at(0).load(1, "Song A", "A").play(1).fader(1, 1)
    .at(5).load(2, "Song B", "B").fader(2, 0).play(2);
  assert.equal(r.at(60).pick(), "Song A / A");
});

test("auto: during a blend the incoming track takes over once established", () => {
  const r = rig({ minPlaySeconds: 10 })
    .at(0).load(1, "Song A", "A").play(1).fader(1, 1)
    .at(100).load(2, "Song B", "B").fader(2, 0).play(2);
  assert.equal(r.at(105).pick(), "Song A / A", "B is still cueing");
  r.at(140).fader(2, 0.8);
  assert.equal(r.at(145).pick(), "Song A / A", "B cued for 40 s but only heard for 5 s");
  assert.equal(r.at(150).pick(), "Song B / B", "B heard for 10 s → takes over");
  r.fader(1, 0).play(1, false);
  assert.equal(r.at(160).pick(), "Song B / B");
});

test("auto: pulling the fader down and back up restarts the heard clock", () => {
  const r = rig({ minPlaySeconds: 10 }).at(0).load(1, "Song A", "A").play(1).fader(1, 1);
  assert.equal(r.at(10).pick(), "Song A / A");
  r.fader(1, 0);
  assert.equal(r.at(11).pick(), null, "silent deck doesn't count");
  r.at(12).fader(1, 1);
  assert.equal(r.at(15).pick(), null);
  assert.equal(r.at(22).pick(), "Song A / A");
});

test("auto: unknown fader position counts as audible (players without a mixer)", () => {
  const r = rig({ minPlaySeconds: 5 }).at(0).load(1, "Song A", "A").play(1);
  assert.equal(r.at(6).pick(), "Song A / A");
});

test("auto: a mixer channel fader is used when the deck reports no volume", () => {
  const r = rig({ minPlaySeconds: 0 }).at(0).load(1, "Song A", "A").play(1);
  r.t.apply(DEV, "/Mixer/CH1faderPosition", { value: 0 }, 0);
  assert.equal(r.pick(), null);
  r.t.apply(DEV, "/Mixer/CH1faderPosition", { value: 0.5 }, 0);
  assert.equal(r.pick(), "Song A / A");
});

test("auto: loading a new track onto a rolling deck restarts its clock", () => {
  const r = rig({ minPlaySeconds: 10 }).at(0).load(1, "Song A", "A").play(1);
  assert.equal(r.at(20).pick(), "Song A / A");
  r.load(1, "Song C", "C");
  assert.equal(r.at(25).pick(), null);
  assert.equal(r.at(30).pick(), "Song C / C");
});

test("stopping or ejecting clears the selection", () => {
  const r = rig({ minPlaySeconds: 0 }).at(0).load(1, "Song A", "A").play(1);
  assert.equal(r.pick(), "Song A / A");
  r.play(1, false);
  assert.equal(r.pick(), null);
  r.play(1, true);
  r.t.apply(DEV, "/Engine/Deck1/Track/SongLoaded", { state: false }, 0);
  assert.equal(r.pick(), null);
});

test("master: picks the playing master deck regardless of start order", () => {
  const r = rig({ mode: "master", minPlaySeconds: 10 })
    .at(0).load(1, "Song A", "A").play(1).master(1)
    .at(50).load(2, "Song B", "B").play(2);
  assert.equal(r.at(100).pick(), "Song A / A");
  r.master(1, false).master(2, true);
  assert.equal(r.pick(), "Song B / B");
});

test("deck:N: follows one deck only", () => {
  const r = rig({ mode: "deck", deck: 2 })
    .at(0).load(1, "Song A", "A").play(1)
    .load(2, "Song B", "B");
  assert.equal(r.pick(), null);
  r.play(2);
  assert.equal(r.pick(), "Song B / B");
});

test("decks on different devices are tracked separately; forgetDevice drops them", () => {
  const t = new DeckTracker({ minPlaySeconds: 0 });
  t.apply("a", "/Engine/Deck1/Track/SongName", { string: "From A" }, 0);
  t.apply("a", "/Engine/Deck1/PlayState", { state: true }, 0);
  t.apply("b", "/Engine/Deck1/Track/SongName", { string: "From B" }, 5);
  t.apply("b", "/Engine/Deck1/PlayState", { state: true }, 5);
  assert.equal(t.select(10).title, "From B");
  t.forgetDevice("b");
  assert.equal(t.select(10).title, "From A");
});

test("ignores unknown paths and malformed values", () => {
  const t = new DeckTracker({ minPlaySeconds: 0 });
  assert.equal(t.apply(DEV, "/Engine/Deck9/PlayState", { state: true }, 0), false);
  assert.equal(t.apply(DEV, "/Something/Else", { state: true }, 0), false);
  t.apply(DEV, "/Engine/Deck1/Track/SongName", { string: 42 }, 0);
  t.apply(DEV, "/Engine/Deck1/PlayState", { state: "yes" }, 0);
  assert.equal(t.select(0), null);
});

test("nextQualifyIn reports when a deck will cross minPlaySeconds", () => {
  const r = rig({ minPlaySeconds: 10 }).at(0).load(1, "Song A", "A").play(1);
  assert.equal(r.t.nextQualifyIn(4 * S), 6 * S);
  assert.equal(r.t.nextQualifyIn(11 * S), null);
});
