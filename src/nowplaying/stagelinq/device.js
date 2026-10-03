"use strict";

const net = require("node:net");
const { EventEmitter } = require("node:events");
const {
  MainStreamParser,
  StateMapParser,
  encodeServicesRequest,
  encodeServiceAnnouncement,
  encodeSubscribe,
} = require("./wire");

const CONNECT_TIMEOUT_MS = 5000;
// Firmware asks for our services before it will answer a request for its
// own; wait this long for that before sending ours anyway.
const SERVICES_REQUEST_GRACE_MS = 1500;
const SERVICES_TIMEOUT_MS = 5000;
// chrisle/StageLinq (known to work on Engine OS 5) pauses before opening a
// service connection after the handshake; do the same.
const STATEMAP_DELAY_MS = 500;
// How many incoming state names to trace (for --debug) before going quiet.
const TRACE_STATES = 5;

/**
 * One connection to a StagelinQ device: the main connection (service
 * discovery) and a StateMap connection subscribed to `paths`.
 *
 * The handshake follows chrisle/StageLinq, which works on Engine OS 5: wait
 * for the device's services request, send ours, collect the service list,
 * pause, then open StateMap. No periodic reference/timestamp messages are sent
 * (go-stagelinq sends them; chrisle does not).
 *
 * Only losing the StateMap connection ends the session: if the device drops
 * the main connection once StateMap is flowing, we carry on.
 *
 * Events:
 *   "state"  { name, value }   value is the parsed JSON object
 *   "ready"  { services }      StateMap subscriptions sent
 *   "close"  { reason }        session is over (emitted once)
 */
class DeviceConnection extends EventEmitter {
  constructor(device, { token, paths, netImpl = net, trace = () => {} }) {
    super();
    this.device = device;
    this.token = token;
    this.paths = new Set(paths);
    this.net = netImpl;
    this.trace = trace;
    this.sockets = [];
    this.timers = [];
    this.closed = false;
    this.started = Date.now();
    this.statesReceived = 0;
  }

  elapsed() {
    return `${((Date.now() - this.started) / 1000).toFixed(1)}s`;
  }

  connect() {
    const main = this.dial("main", this.device.port, { fatalClose: true });
    const parser = new MainStreamParser();
    const services = new Map();
    let requested = false;

    const requestServices = (why) => {
      if (requested || this.closed) return;
      requested = true;
      this.trace(`[${this.elapsed()}] main: sending services request (${why})`);
      main.write(encodeServicesRequest(this.token));
      this.after(SERVICES_TIMEOUT_MS, () => {
        if (!this.stateMapStarted) {
          this.close(`device did not offer a StateMap service (got: ${[...services.keys()].join(", ") || "none"})`);
        }
      });
    };

    main.on("connect", () => {
      this.trace(`[${this.elapsed()}] main: connected to ${this.device.address}:${this.device.port}`);
      this.after(SERVICES_REQUEST_GRACE_MS, () => requestServices("device did not ask first"));
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
        if (m.type === "services-request") {
          this.trace(`[${this.elapsed()}] main: device asked for our services`);
          requestServices("device asked first");
        } else if (m.type === "service") {
          if (!services.has(m.service)) this.trace(`[${this.elapsed()}] main: device offers ${m.service} on port ${m.port}`);
          services.set(m.service, m.port);
        }
      }
      if (requested && services.has("StateMap") && !this.stateMapScheduled) {
        this.stateMapScheduled = true;
        this.after(STATEMAP_DELAY_MS, () => this.startStateMap(services));
      }
    });
  }

  startStateMap(services) {
    if (this.stateMapStarted || this.closed) return;
    this.stateMapStarted = true;
    const port = services.get("StateMap");
    const sock = this.dial("StateMap", port, { fatalClose: true });
    const parser = new StateMapParser();
    // From here on, the main connection is no longer essential.
    for (const s of this.sockets) if (s.label === "main") s.fatalClose = false;

    sock.on("connect", () => {
      this.trace(`[${this.elapsed()}] StateMap: connected on port ${port}; subscribing to ${this.paths.size} values`);
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
        if (!value || typeof value !== "object") continue;
        this.statesReceived += 1;
        if (this.statesReceived <= TRACE_STATES) {
          this.trace(`[${this.elapsed()}] StateMap: received ${m.name}`);
        }
        this.emit("state", { name: m.name, value });
      }
    });
  }

  dial(label, port, { fatalClose }) {
    const sock = this.net.connect({ host: this.device.address, port });
    sock.label = label;
    sock.fatalClose = fatalClose;
    sock.bytesIn = 0;
    this.sockets.push(sock);
    sock.setNoDelay?.(true);
    sock.setKeepAlive?.(true, 10_000);
    sock.setTimeout?.(CONNECT_TIMEOUT_MS);
    sock.once("connect", () => sock.setTimeout?.(0));
    sock.on("data", (chunk) => {
      sock.bytesIn += chunk.length;
    });
    sock.on("timeout", () => this.close(`${label}: timed out connecting to ${this.device.address}:${port}`));
    sock.on("error", (err) => this.close(`${label}: ${err.code || err.message}`));
    sock.on("close", () => {
      if (this.closed) return;
      const detail = `${label} connection closed by device after ${this.elapsed()} (${sock.bytesIn} bytes received, ${this.statesReceived} state updates)`;
      if (sock.fatalClose) this.close(detail);
      else this.trace(`[${this.elapsed()}] ${detail}; carrying on with StateMap`);
    });
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
