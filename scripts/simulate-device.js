#!/usr/bin/env node
"use strict";

/**
 * Development aid: pretend to be a two-deck StagelinQ player on this machine's
 * LAN address, so `now-playing watch --dry-run` can be exercised end to end
 * without hardware. Plays a short scripted set:
 *
 *   0 s   deck 1 loads "Song A" and plays (fader up)
 *   8 s   deck 2 loads "Song B" and plays with the fader DOWN (cueing)
 *  14 s   deck 2 fader up (blend)
 *  26 s   deck 1 stops
 *  36 s   deck 2 stops → nothing playing
 *
 * Usage: node scripts/simulate-device.js [--interface <ip>]
 * Then, in another terminal:
 *   node bin/djrequest-link.js now-playing watch --dry-run --min-play 5 --idle-clear 1
 */

const dgram = require("node:dgram");
const { parseArgs } = require("node:util");
const { localInterfaces } = require("../src/nowplaying/stagelinq/discovery");
const w = require("../src/nowplaying/stagelinq/wire");
const { startFakeDevice } = require("../test/fake-device");

async function main() {
  const { values } = parseArgs({ options: { interface: { type: "string" } } });
  const iface = localInterfaces(values.interface)[0];
  if (!iface) throw new Error("No usable IPv4 interface found.");

  const fake = await startFakeDevice({ host: iface.address });
  console.log(`Fake player on ${iface.address}:${fake.device.port}, announcing to ${iface.broadcast}:51337`);

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  await new Promise((r) => sock.bind({ address: iface.address, port: 0 }, r));
  sock.setBroadcast(true);
  const announce = (action) =>
    sock.send(
      w.encodeDiscovery({
        token: fake.device.token,
        source: "SimPlayer",
        action,
        softwareName: "JP11",
        softwareVersion: "4.0.0",
        port: fake.device.port,
      }),
      w.DISCOVERY_PORT,
      iface.broadcast
    );
  const announcer = setInterval(() => announce(w.ACTION_HOWDY), 1000);
  announce(w.ACTION_HOWDY);

  // Wait for a subscriber, then run the script.
  while (fake.subscriptions.length === 0) await new Promise((r) => setTimeout(r, 200));
  console.log("Subscriber connected; starting the set.");

  const deck = (n, leaf, value) => fake.emit(`/Engine/Deck${n}/${leaf}`, value);
  const steps = [
    [0, "deck 1: Song A, playing", () => {
      deck(1, "Track/SongLoaded", { state: true, type: 1 });
      deck(1, "Track/SongName", { string: "Song A", type: 8 });
      deck(1, "Track/ArtistName", { string: "Artist A", type: 8 });
      deck(1, "ExternalMixerVolume", { value: 1, type: 0 });
      deck(1, "PlayState", { state: true, type: 1 });
    }],
    [8, "deck 2: Song B, cueing (fader down)", () => {
      deck(2, "Track/SongLoaded", { state: true, type: 1 });
      deck(2, "Track/SongName", { string: "Song B", type: 8 });
      deck(2, "Track/ArtistName", { string: "Artist B", type: 8 });
      deck(2, "ExternalMixerVolume", { value: 0, type: 0 });
      deck(2, "PlayState", { state: true, type: 1 });
    }],
    [14, "deck 2: fader up", () => deck(2, "ExternalMixerVolume", { value: 0.9, type: 0 })],
    [26, "deck 1: stop", () => deck(1, "PlayState", { state: false, type: 1 })],
    [36, "deck 2: stop", () => deck(2, "PlayState", { state: false, type: 1 })],
  ];
  const start = Date.now();
  for (const [at, label, fn] of steps) {
    await new Promise((r) => setTimeout(r, Math.max(0, start + at * 1000 - Date.now())));
    console.log(`t=${at}s ${label}`);
    fn();
  }
  console.log("Set finished. Ctrl+C to stop the simulator.");
  process.once("SIGINT", async () => {
    clearInterval(announcer);
    announce(w.ACTION_EXIT);
    setTimeout(async () => {
      sock.close();
      await fake.close();
      process.exit(0);
    }, 200);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
