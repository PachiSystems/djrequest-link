"use strict";

const net = require("node:net");
const { EventEmitter } = require("node:events");
const {
  MainStreamParser,
  StateMapParser,
  encodeServicesRequest,
  encodeServiceAnnouncement,
  encodeReference,
  encodeSubscribe,
} = require("./wire");

const CONNECT_TIMEOUT_MS = 5000;
// Some firmware only answers a services request after asking us first; wait
// this long for its request before sending ours anyway.
const SERVICES_REQUEST_GRACE_MS = 1500;
const SERVICES_TIMEOUT_MS = 5000;
const REFERENCE_INTERVAL_MS = 250;

/**
 * One connection to a StagelinQ device: the main connection (service
 * discovery + keepalive) and a StateMap connection subscribed to `paths`.
 *
 * Events:
 *   "state"  { name, value }   value is the parsed JSON object
 *   "ready"  { services }      StateMap subscribed
 *   "close"  { reason }        connection is gone (emitted once)
 */
class DeviceConnection extends EventEmitter {
  constructor(device, { token, paths, netImpl = net }) {
    super();
    this.device = device;
    this.token = token;
    this.paths = new Set(paths);
    this.net = netImpl;
    this.sockets = [];
    this.timers = [];
    this.closed = false;
  }

  connect() {
    const main = this.dial(this.device.port);
    const parser = new MainStreamParser();
    const services = new Map();
    let requested = false;

    const requestServices = () => {
      if (requested || this.closed) return;
      requested = true;
      main.write(encodeServicesRequest(this.token));
      this.after(SERVICES_TIMEOUT_MS, () => {
        if (!this.stateMapStarted) this.close("device did not offer a StateMap service");
      });
    };

    main.on("connect", () => {
      this.after(SERVICES_REQUEST_GRACE_MS, requestServices);
      const t = setInterval(() => {
        if (!main.destroyed) main.write(encodeReference(this.token, this.device.token));
      }, REFERENCE_INTERVAL_MS);
      this.timers.push({ clear: () => clearInterval(t) });
    });

    main.on("data", (chunk) => {
      let messages;
      try {
        messages = parser.push(chunk);
      } catch (err) {
        this.close(`protocol error on main connection: ${err.message}`);
        return;
      }
      for (const m of messages) {
        if (m.type === "services-request") requestServices();
        else if (m.type === "service") services.set(m.service, m.port);
        else if (m.type === "reference" && requested && services.has("StateMap")) {
          this.startStateMap(services);
        }
      }
      // Some firmware never sends the terminating reference; start as soon as
      // StateMap is known.
      if (requested && services.has("StateMap")) this.startStateMap(services);
    });
  }

  startStateMap(services) {
    if (this.stateMapStarted || this.closed) return;
    this.stateMapStarted = true;
    const port = services.get("StateMap");
    const sock = this.dial(port);
    const parser = new StateMapParser();

    sock.on("connect", () => {
      sock.write(encodeServiceAnnouncement(this.token, "StateMap", sock.localPort || 0));
      for (const path of this.paths) sock.write(encodeSubscribe(path, 0));
      this.emit("ready", { services: [...services.keys()] });
    });

    sock.on("data", (chunk) => {
      let messages;
      try {
        messages = parser.push(chunk);
      } catch (err) {
        this.close(`protocol error on StateMap: ${err.message}`);
        return;
      }
      for (const m of messages) {
        // Only forward values we asked for; ignore anything else on the wire.
        if (m.type !== "emit" || !this.paths.has(m.name)) continue;
        let value;
        try {
          value = JSON.parse(m.json);
        } catch {
          continue;
        }
        if (value && typeof value === "object") this.emit("state", { name: m.name, value });
      }
    });
  }

  dial(port) {
    const sock = this.net.connect({ host: this.device.address, port });
    this.sockets.push(sock);
    sock.setNoDelay?.(true);
    sock.setKeepAlive?.(true, 10_000);
    sock.setTimeout?.(CONNECT_TIMEOUT_MS);
    sock.once("connect", () => sock.setTimeout?.(0));
    sock.on("timeout", () => this.close(`timed out connecting to ${this.device.address}:${port}`));
    sock.on("error", (err) => this.close(err.code || err.message));
    sock.on("close", () => this.close("connection closed by device"));
    return sock;
  }

  after(ms, fn) {
    const t = setTimeout(fn, ms);
    this.timers.push({ clear: () => clearTimeout(t) });
  }

  close(reason = "closed") {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) t.clear();
    for (const s of this.sockets) s.destroy();
    this.emit("close", { reason });
  }
}

module.exports = { DeviceConnection };
