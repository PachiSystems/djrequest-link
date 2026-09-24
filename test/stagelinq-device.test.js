"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { DeviceConnection } = require("../src/nowplaying/stagelinq/device");
const { STATE_PATHS } = require("../src/nowplaying/stagelinq");
const { startFakeDevice } = require("./fake-device");

const TOKEN = Buffer.alloc(16, 0x11);

async function connected(fake) {
  const conn = new DeviceConnection(fake.device, { token: TOKEN, paths: STATE_PATHS });
  const ready = once(conn, "ready");
  conn.connect();
  await ready;
  // Wait until the fake device has received every subscription.
  for (let i = 0; i < 100 && fake.subscriptions.length < STATE_PATHS.length; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return conn;
}

test("handshake, subscribe, and receive deck state from a device", async (t) => {
  const fake = await startFakeDevice();
  t.after(() => fake.close());
  const conn = await connected(fake);
  t.after(() => conn.close());

  assert.deepEqual(new Set(fake.subscriptions), new Set(STATE_PATHS));
  assert.ok(!fake.subscriptions.some((p) => /NetworkPath|TrackUri|AlbumArt/.test(p)), "no file paths or artwork");

  const states = [];
  conn.on("state", (s) => states.push(s));
  fake.emit("/Engine/Deck1/Track/SongName", { string: "Song A", type: 8 });
  fake.emit("/Engine/Deck1/Track/TrackNetworkPath", { string: "net://x/Music/secret.mp3", type: 8 });
  fake.emit("/Engine/Deck1/PlayState", "not json at all");
  fake.emit("/Engine/Deck1/PlayState", { state: true, type: 1 });
  await new Promise((r) => setTimeout(r, 100));

  assert.deepEqual(states, [
    { name: "/Engine/Deck1/Track/SongName", value: { string: "Song A", type: 8 } },
    { name: "/Engine/Deck1/PlayState", value: { state: true, type: 1 } },
  ]);
});

test("works with firmware that does not ask for our services first", async (t) => {
  const fake = await startFakeDevice({ askFirst: false });
  t.after(() => fake.close());
  const conn = await connected(fake);
  t.after(() => conn.close());
  assert.equal(fake.subscriptions.length, STATE_PATHS.length);
});

test("a malformed StateMap stream closes the connection instead of crashing", async (t) => {
  const fake = await startFakeDevice();
  t.after(() => fake.close());
  const conn = await connected(fake);
  const closed = once(conn, "close");
  fake.writeRaw(Buffer.from([0x7f, 0xff, 0xff, 0xff])); // 2 GB frame length
  const [{ reason }] = await closed;
  assert.match(reason, /too large/);
});

test("device going away emits close", async (t) => {
  const fake = await startFakeDevice();
  t.after(() => fake.close());
  const conn = await connected(fake);
  const closed = once(conn, "close");
  fake.dropConnections();
  await closed;
});

test("connection refused emits close", async () => {
  const conn = new DeviceConnection(
    { id: "x", token: Buffer.alloc(16), address: "127.0.0.1", port: 1 },
    { token: TOKEN, paths: STATE_PATHS }
  );
  const closed = once(conn, "close");
  conn.connect();
  const [{ reason }] = await closed;
  assert.ok(reason);
});
