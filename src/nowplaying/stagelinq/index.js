"use strict";

const { EventEmitter } = require("node:events");
const { makeToken } = require("./wire");
const { Discovery } = require("./discovery");
const { DeviceConnection } = require("./device");

const DECKS = [1, 2, 3, 4];

/**
 * The StateMap values we subscribe to: play state, track title/artist, and
 * volume/fader position per deck. Deliberately small — no file paths, no
 * artwork, no high-frequency transport data (playhead, beat info).
 */
const STATE_PATHS = [
  ...DECKS.flatMap((n) => [
    `/Engine/Deck${n}/Play`,
    `/Engine/Deck${n}/PlayState`,
    `/Engine/Deck${n}/DeckIsMaster`,
    `/Engine/Deck${n}/ExternalMixerVolume`,
    `/Engine/Deck${n}/Track/SongLoaded`,
    `/Engine/Deck${n}/Track/SongName`,
    `/Engine/Deck${n}/Track/ArtistName`,
  ]),
  ...DECKS.map((n) => `/Mixer/CH${n}faderPosition`),
];

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Discovers StagelinQ devices and keeps a StateMap subscription open to each.
 *
 * Events:
 *   "device-connected"    device
 *   "device-disconnected" { device, reason }
 *   "state"               { deviceId, name, value }
 *   "error"               Error (discovery socket)
 */
class StagelinqClient extends EventEmitter {
  constructor({ interfaceAddress, softwareVersion = "0.0.0", discoveryImpl, connectionImpl } = {}) {
    super();
    this.token = makeToken();
    this.discovery = (discoveryImpl || ((o) => new Discovery(o)))({
      token: this.token,
      name: "djrequest-link",
      softwareName: "djrequest-link",
      softwareVersion,
      interfaceAddress,
    });
    this.makeConnection = connectionImpl || ((device, opts) => new DeviceConnection(device, opts));
    this.connections = new Map(); // device id → connection
    this.retries = new Map(); // device id → { attempts, timer }
    this.stopped = false;

    this.discovery.on("device", (d) => this.onDevice(d));
    this.discovery.on("device-lost", ({ id }) => this.drop(id, "device left the network"));
    this.discovery.on("error", (err) => this.emit("error", err));
  }

  start() {
    return this.discovery.start();
  }

  async stop() {
    this.stopped = true;
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
    for (const conn of this.connections.values()) conn.close("shutting down");
    this.connections.clear();
    await this.discovery.stop();
  }

  onDevice(device) {
    if (this.stopped || this.connections.has(device.id)) return;
    const retry = this.retries.get(device.id);
    if (retry && retry.timer) return; // a reconnect is already scheduled
    this.connect(device);
  }

  connect(device) {
    const conn = this.makeConnection(device, { token: this.token, paths: STATE_PATHS });
    this.connections.set(device.id, conn);
    conn.on("ready", () => {
      this.retries.delete(device.id);
      this.emit("device-connected", device);
    });
    conn.on("state", ({ name, value }) => this.emit("state", { deviceId: device.id, name, value }));
    conn.on("close", ({ reason }) => {
      if (this.connections.get(device.id) !== conn) return;
      this.connections.delete(device.id);
      this.emit("device-disconnected", { device, reason });
      this.scheduleReconnect(device);
    });
    conn.connect();
  }

  scheduleReconnect(device) {
    if (this.stopped || !this.discovery.devices.has(device.id)) return;
    const r = this.retries.get(device.id) || { attempts: 0, timer: null };
    r.attempts += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (r.attempts - 1));
    r.timer = setTimeout(() => {
      r.timer = null;
      const latest = this.discovery.devices.get(device.id);
      if (latest && !this.stopped) this.connect(latest);
    }, delay);
    this.retries.set(device.id, r);
  }

  drop(id, reason) {
    const r = this.retries.get(id);
    if (r) clearTimeout(r.timer);
    this.retries.delete(id);
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    conn.close(reason);
    this.emit("device-disconnected", { device: conn.device, reason });
  }
}

module.exports = { StagelinqClient, STATE_PATHS };
