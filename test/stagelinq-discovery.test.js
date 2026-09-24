"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Discovery, localInterfaces, isLocalPeer, isIgnoredSoftware } = require("../src/nowplaying/stagelinq/discovery");
const w = require("../src/nowplaying/stagelinq/wire");

const OUR_TOKEN = Buffer.alloc(16, 0x01);
const DEVICE_TOKEN = Buffer.alloc(16, 0x02);

const IFACES = localInterfaces(null, {
  eth0: [{ family: "IPv4", internal: false, address: "192.168.1.20", netmask: "255.255.255.0" }],
  lo: [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }],
  wifi: [{ family: "IPv4", internal: false, address: "169.254.3.4", netmask: "255.255.0.0" }],
  v6: [{ family: "IPv6", internal: false, address: "fe80::1", netmask: "ffff::" }],
});

function howdy(overrides = {}) {
  return w.encodeDiscovery({
    token: DEVICE_TOKEN,
    source: "Prime 4",
    action: w.ACTION_HOWDY,
    softwareName: "JC11",
    softwareVersion: "4.0.0",
    port: 50010,
    ...overrides,
  });
}

function discovery() {
  const d = new Discovery({ token: OUR_TOKEN, name: "x", softwareName: "x", softwareVersion: "0", getInterfaces: () => IFACES });
  const events = [];
  d.on("device", (e) => events.push(["device", e.id]));
  d.on("device-lost", (e) => events.push(["lost", e.id]));
  return { d, events };
}

test("localInterfaces keeps LAN IPv4 only and computes the broadcast address", () => {
  assert.deepEqual(
    IFACES.map((i) => [i.address, i.broadcast]),
    [["192.168.1.20", "192.168.1.255"]]
  );
});

test("isLocalPeer accepts only hosts on our subnets", () => {
  assert.equal(isLocalPeer("192.168.1.77", IFACES), true);
  assert.equal(isLocalPeer("192.168.2.77", IFACES), false);
  assert.equal(isLocalPeer("8.8.8.8", IFACES), false);
  assert.equal(isLocalPeer("::ffff:192.168.1.77", IFACES), false);
});

test("ignores SoundSwitch, Resolume, the analyzer, and X1800/X1850 mixers", () => {
  for (const name of ["OfflineAnalyzer", "SoundSwitch", "Resolume Arena", "SSS0", "JM08"]) {
    assert.equal(isIgnoredSoftware(name), true, name);
  }
  assert.equal(isIgnoredSoftware("JC11"), false);
});

test("a device on the LAN is reported once, then forgotten on exit", () => {
  const { d, events } = discovery();
  const rinfo = { address: "192.168.1.50" };
  d.onMessage(howdy(), rinfo);
  d.onMessage(howdy(), rinfo);
  d.onMessage(howdy({ action: w.ACTION_EXIT }), rinfo);
  const id = `${DEVICE_TOKEN.toString("hex")}@192.168.1.50:50010`;
  assert.deepEqual(events, [["device", id], ["lost", id]]);
});

test("drops packets from off-subnet hosts, ourselves, ignored software, and junk", () => {
  const { d, events } = discovery();
  d.onMessage(howdy(), { address: "10.0.0.5" });
  d.onMessage(howdy({ token: OUR_TOKEN }), { address: "192.168.1.20" });
  d.onMessage(howdy({ softwareName: "SoundSwitch" }), { address: "192.168.1.50" });
  d.onMessage(Buffer.from("airD but not really"), { address: "192.168.1.50" });
  d.onMessage(Buffer.alloc(9000), { address: "192.168.1.50" });
  assert.deepEqual(events, []);
});

test("the same token on two ports is two devices (no flapping)", () => {
  const { d, events } = discovery();
  d.onMessage(howdy({ port: 1 }), { address: "192.168.1.50" });
  d.onMessage(howdy({ port: 2 }), { address: "192.168.1.50" });
  d.onMessage(howdy({ port: 1 }), { address: "192.168.1.50" });
  assert.equal(events.length, 2);
  assert.equal(d.devices.size, 2);
});

test("devices that go silent expire", () => {
  const { d, events } = discovery();
  d.onMessage(howdy(), { address: "192.168.1.50" });
  const [device] = d.devices.values();
  d.expire(device.lastSeen + 9_000);
  assert.equal(d.devices.size, 1);
  d.expire(device.lastSeen + 11_000);
  assert.equal(d.devices.size, 0);
  assert.equal(events.at(-1)[0], "lost");
});

test("device names and versions are length-capped", () => {
  const { d } = discovery();
  d.onMessage(howdy({ source: "x".repeat(200), softwareVersion: "9".repeat(200) }), { address: "192.168.1.50" });
  const [device] = d.devices.values();
  assert.equal(device.name.length, 64);
  assert.equal(device.version.length, 32);
});
