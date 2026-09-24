"use strict";

const dgram = require("node:dgram");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const {
  DISCOVERY_PORT,
  ACTION_HOWDY,
  ACTION_EXIT,
  encodeDiscovery,
  decodeDiscovery,
} = require("./wire");

const ANNOUNCE_INTERVAL_MS = 1000;
// Devices announce every second; one silent for this long is gone.
const DEVICE_TIMEOUT_MS = 10_000;

// Software that announces on StagelinQ but has no decks to read (or that is
// known to misbehave when a third party connects). Mirrors chrisle/StageLinq.
// JM08 is the X1800/X1850 mixer: it only carries mixer state, and connecting
// to it has been reported to cause problems.
const IGNORED_SOFTWARE = [/^OfflineAnalyzer$/, /^SoundSwitch/i, /^Resolume/i, /^SSS0$/, /^JM08$/];

/** IPv4 → 32-bit unsigned int. */
function ipToInt(ip) {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

/**
 * Local IPv4 interfaces we are willing to use, with their broadcast address.
 * Loopback and link-local (169.254/16) are skipped. `only` restricts to one
 * interface address (the --interface option).
 */
function localInterfaces(only, interfaces = os.networkInterfaces()) {
  const result = [];
  for (const entries of Object.values(interfaces)) {
    for (const e of entries || []) {
      if (e.family !== "IPv4" && e.family !== 4) continue;
      if (e.internal || e.address.startsWith("169.254.")) continue;
      if (only && e.address !== only) continue;
      const addr = ipToInt(e.address);
      const mask = ipToInt(e.netmask);
      result.push({
        address: e.address,
        network: (addr & mask) >>> 0,
        mask,
        broadcast: intToIp(((addr & mask) | ~mask) >>> 0),
      });
    }
  }
  return result;
}

/** True when `ip` is on the same subnet as one of our interfaces. */
function isLocalPeer(ip, interfaces) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const n = ipToInt(ip);
  return interfaces.some((i) => ((n & i.mask) >>> 0) === i.network);
}

function isIgnoredSoftware(name) {
  return IGNORED_SOFTWARE.some((re) => re.test(name));
}

/**
 * Listens for StagelinQ devices on UDP 51337 and announces us every second
 * (devices only talk to applications they have seen announce).
 *
 * Security: the listening socket must bind the wildcard address to receive
 * broadcasts, but every datagram is checked — it must come from a host on one
 * of our own local subnets (or the chosen --interface), parse as a bounded,
 * well-formed StagelinQ message, and not be from ignored software. We open no
 * TCP listening ports at all.
 *
 * Events:
 *   "device"      { id, address, port, name, software, version }   (newly seen)
 *   "device-lost" { id }                                           (exited or silent 10 s)
 *   "error"       Error                                           (socket failure)
 */
class Discovery extends EventEmitter {
  constructor({ token, name, softwareName, softwareVersion, interfaceAddress, dgramImpl = dgram, getInterfaces } = {}) {
    super();
    this.token = token;
    this.identity = { source: name, softwareName, softwareVersion };
    this.interfaceAddress = interfaceAddress || null;
    this.dgram = dgramImpl;
    this.getInterfaces = getInterfaces || (() => localInterfaces(this.interfaceAddress));
    this.devices = new Map();
    this.sendSockets = new Map(); // local address → socket
    this.listenSocket = null;
    this.timer = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const sock = this.dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.listenSocket = sock;
      sock.on("message", (msg, rinfo) => this.onMessage(msg, rinfo));
      sock.once("error", (err) => {
        if (!this.timer) reject(err);
        else this.emit("error", err);
      });
      sock.bind(DISCOVERY_PORT, () => {
        this.announce(ACTION_HOWDY);
        this.timer = setInterval(() => {
          this.announce(ACTION_HOWDY);
          this.expire();
        }, ANNOUNCE_INTERVAL_MS);
        this.timer.unref?.();
        resolve();
      });
    });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.announce(ACTION_EXIT);
    for (const s of this.sendSockets.values()) s.close();
    this.sendSockets.clear();
    if (this.listenSocket) this.listenSocket.close();
    this.listenSocket = null;
  }

  onMessage(msg, rinfo) {
    if (msg.length > 8192) return;
    if (!isLocalPeer(rinfo.address, this.getInterfaces())) return;
    const m = decodeDiscovery(msg);
    if (!m || m.token.equals(this.token)) return;
    if (isIgnoredSoftware(m.softwareName)) return;

    // A device is its token at an address and port: a restarted device (new
    // port) is a new device, and two announcers sharing a token can't make
    // one connection flap between them.
    const id = `${m.token.toString("hex")}@${rinfo.address}:${m.port}`;
    if (m.action === ACTION_EXIT) {
      if (this.devices.delete(id)) this.emit("device-lost", { id });
      return;
    }

    const known = this.devices.get(id);
    if (known) {
      known.lastSeen = Date.now();
      return;
    }
    const device = {
      id,
      token: m.token,
      address: rinfo.address,
      port: m.port,
      name: m.source.slice(0, 64),
      software: m.softwareName.slice(0, 64),
      version: m.softwareVersion.slice(0, 32),
      lastSeen: Date.now(),
    };
    this.devices.set(id, device);
    this.emit("device", device);
  }

  /** Forget devices that stopped announcing (powered off without saying goodbye). */
  expire(now = Date.now()) {
    for (const [id, d] of this.devices) {
      if (now - d.lastSeen > DEVICE_TIMEOUT_MS) {
        this.devices.delete(id);
        this.emit("device-lost", { id });
      }
    }
  }

  /**
   * Broadcast one announcement on every usable interface. A socket per local
   * address is required on Windows, which otherwise sends broadcasts out of a
   * single arbitrary interface.
   */
  async announce(action) {
    const msg = encodeDiscovery({ token: this.token, action, ...this.identity, port: 0 });
    const ifaces = this.getInterfaces();
    const live = new Set(ifaces.map((i) => i.address));
    for (const [addr, s] of this.sendSockets) {
      if (!live.has(addr)) {
        s.close();
        this.sendSockets.delete(addr);
      }
    }
    await Promise.all(
      ifaces.map(async (iface) => {
        try {
          const sock = await this.sendSocketFor(iface.address);
          await new Promise((resolve) => sock.send(msg, DISCOVERY_PORT, iface.broadcast, () => resolve()));
        } catch {
          /* interface went away mid-send; the next tick re-evaluates */
        }
      })
    );
  }

  sendSocketFor(address) {
    const existing = this.sendSockets.get(address);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const sock = this.dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.once("error", reject);
      sock.bind({ address, port: 0 }, () => {
        sock.setBroadcast(true);
        sock.removeListener("error", reject);
        sock.on("error", () => {
          sock.close();
          this.sendSockets.delete(address);
        });
        this.sendSockets.set(address, sock);
        resolve(sock);
      });
    });
  }
}

module.exports = { Discovery, localInterfaces, isLocalPeer, isIgnoredSoftware, ipToInt };
