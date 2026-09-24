"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const w = require("../src/nowplaying/stagelinq/wire");

const TOKEN = Buffer.alloc(16, 0x11);
const DEVICE_TOKEN = Buffer.alloc(16, 0x22);

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** A StateMap emit frame as a device would send it. */
function emitFrame(name, json) {
  const body = Buffer.concat([w.SMAA_MAGIC, u32(w.SMAA_EMIT), w.encodeString(name), w.encodeString(json)]);
  return Buffer.concat([u32(body.length), body]);
}

test("network strings are uint32 length + UTF-16BE", () => {
  const enc = w.encodeString("Aé");
  assert.deepEqual([...enc], [0, 0, 0, 4, 0x00, 0x41, 0x00, 0xe9]);
  assert.deepEqual(w.readString(enc, 0, 100), { value: "Aé", next: 8 });
  assert.equal(w.readString(enc.subarray(0, 6), 0, 100), null, "incomplete → need more");
  assert.throws(() => w.readString(enc, 0, 2), /exceeds/);
  assert.throws(() => w.readString(Buffer.from([0, 0, 0, 3, 0, 65, 0]), 0, 100), /odd/);
});

test("makeToken clears the high bit of the first byte", () => {
  for (let i = 0; i < 50; i++) {
    const t = w.makeToken();
    assert.equal(t.length, 16);
    assert.equal(t[0] & 0x80, 0);
  }
});

test("discovery messages round-trip", () => {
  const msg = w.encodeDiscovery({
    token: TOKEN,
    source: "prime4",
    action: w.ACTION_HOWDY,
    softwareName: "JC11",
    softwareVersion: "3.4.0",
    port: 50010,
  });
  assert.deepEqual(w.decodeDiscovery(msg), {
    token: TOKEN,
    source: "prime4",
    action: w.ACTION_HOWDY,
    softwareName: "JC11",
    softwareVersion: "3.4.0",
    port: 50010,
  });
});

test("decodeDiscovery rejects junk, truncation, bad actions, and huge strings", () => {
  const good = w.encodeDiscovery({
    token: TOKEN, source: "x", action: w.ACTION_HOWDY, softwareName: "y", softwareVersion: "z", port: 1,
  });
  assert.equal(w.decodeDiscovery(Buffer.from("hello world, not stagelinq")), null);
  assert.equal(w.decodeDiscovery(good.subarray(0, good.length - 1)), null);
  const badAction = w.encodeDiscovery({
    token: TOKEN, source: "x", action: "DISCOVERER_PWNED_", softwareName: "y", softwareVersion: "z", port: 1,
  });
  assert.equal(w.decodeDiscovery(badAction), null);
  const hugeLen = Buffer.concat([Buffer.from("airD"), TOKEN, u32(0x7ffffffe)]);
  assert.equal(w.decodeDiscovery(hugeLen), null, "declared length far beyond the bound");
});

test("MainStreamParser handles messages split across chunks", () => {
  const stream = Buffer.concat([
    w.encodeServicesRequest(DEVICE_TOKEN),
    w.encodeServiceAnnouncement(DEVICE_TOKEN, "StateMap", 50020),
    w.encodeServiceAnnouncement(DEVICE_TOKEN, "BeatInfo", 50030),
    w.encodeReference(DEVICE_TOKEN, TOKEN, 123n),
  ]);
  const parser = new w.MainStreamParser();
  const out = [];
  for (let i = 0; i < stream.length; i += 3) out.push(...parser.push(stream.subarray(i, i + 3)));
  assert.deepEqual(
    out.map((m) => [m.type, m.service, m.port]),
    [
      ["services-request", undefined, undefined],
      ["service", "StateMap", 50020],
      ["service", "BeatInfo", 50030],
      ["reference", undefined, undefined],
    ]
  );
});

test("MainStreamParser treats an unknown message id as a desync", () => {
  const parser = new w.MainStreamParser();
  assert.throws(() => parser.push(Buffer.concat([u32(0x99), TOKEN])), /unknown main-connection message/);
});

test("StateMapParser decodes emits, skips a leading raw announcement, and bounds frames", () => {
  const stream = Buffer.concat([
    w.encodeServiceAnnouncement(DEVICE_TOKEN, "StateMap", 0),
    emitFrame("/Engine/Deck1/Track/SongName", '{"string":"Song A","type":8}'),
    emitFrame("/Engine/Deck1/PlayState", '{"state":true,"type":1}'),
  ]);
  const parser = new w.StateMapParser();
  const out = [];
  for (let i = 0; i < stream.length; i += 5) out.push(...parser.push(stream.subarray(i, i + 5)));
  assert.deepEqual(out, [
    { type: "emit", name: "/Engine/Deck1/Track/SongName", json: '{"string":"Song A","type":8}' },
    { type: "emit", name: "/Engine/Deck1/PlayState", json: '{"state":true,"type":1}' },
  ]);

  assert.throws(() => new w.StateMapParser().push(u32(10 * 1024 * 1024)), /too large/);
  assert.throws(
    () => new w.StateMapParser().push(Buffer.concat([u32(8), Buffer.from("nope"), u32(0)])),
    /smaa magic/
  );
});

test("encodeSubscribe produces a length-prefixed smaa subscribe frame", () => {
  const frame = w.encodeSubscribe("/Engine/Deck1/Play", 0);
  assert.equal(frame.readUInt32BE(0), frame.length - 4);
  assert.equal(frame.subarray(4, 8).toString("latin1"), "smaa");
  assert.equal(frame.readUInt32BE(8), w.SMAA_SUBSCRIBE);
  assert.equal(w.readString(frame, 12, 1000).value, "/Engine/Deck1/Play");
  assert.equal(frame.readUInt32BE(frame.length - 4), 0);
});
