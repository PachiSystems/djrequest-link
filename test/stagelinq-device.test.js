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

test("losing only the main connection after StateMap is up does not end the session", async (t) => {
  const fake = await startFakeDevice();
  t.after(() => fake.close());
  const traces = [];
  const conn = new DeviceConnection(fake.device, { token: TOKEN, paths: STATE_PATHS, trace: (m) => traces.push(m) });
  const ready = once(conn, "ready");
  conn.connect();
  await ready;
  t.after(() => conn.close());
  let closed = false;
  conn.on("close", () => (closed = true));

  fake.dropMain();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(closed, false);
  assert.ok(traces.some((m) => /main connection closed by device .*carrying on/.test(m)));

  const states = [];
  conn.on("state", (s) => states.push(s.name));
  fake.emit("/Engine/Deck1/PlayState", { state: true, type: 1 });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(states, ["/Engine/Deck1/PlayState"]);
});

test("losing the StateMap connection ends the session with a detailed reason", async (t) => {
  const fake = await startFakeDevice();
  t.after(() => fake.close());
  const conn = await connected(fake);
  const closed = once(conn, "close");
  fake.dropStateMap();
  const [{ reason }] = await closed;
  assert.match(reason, /StateMap connection closed by device after [\d.]+s \(\d+ bytes received, 0 state updates\)/);
});

test("reconnectAll drops connections and reconnects on the next announcement", async (t) => {
  const { StagelinqClient } = require("../src/nowplaying/stagelinq");
  const { EventEmitter } = require("node:events");
  const fake = await startFakeDevice();
  t.after(() => fake.close());

  // Discovery stand-in we can drive by hand (no UDP).
  const discovery = Object.assign(new EventEmitter(), {
    devices: new Map(),
    start: async () => {},
    stop: async () => {},
  });
  const client = new StagelinqClient({ discoveryImpl: () => discovery });
  t.after(() => client.stop());
  const announce = () => {
    discovery.devices.set(fake.device.id, fake.device);
    discovery.emit("device", fake.device);
  };

  const connected = [];
  const disconnected = [];
  client.on("device-connected", (d) => connected.push(d.id));
  client.on("device-disconnected", ({ reason }) => disconnected.push(reason));

  announce();
  await once(client, "device-connected");

  client.reconnectAll("woke from sleep");
  assert.deepEqual(disconnected, ["woke from sleep"]);
  assert.equal(client.connections.size, 0);
  assert.equal(discovery.devices.size, 0, "known devices forgotten");

  announce(); // the device's next 1-second announcement
  await once(client, "device-connected");
  assert.equal(connected.length, 2);
});
