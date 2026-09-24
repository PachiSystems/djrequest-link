"use strict";

const net = require("node:net");
const w = require("../src/nowplaying/stagelinq/wire");

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function emitFrame(name, value) {
  const body = Buffer.concat([
    w.SMAA_MAGIC,
    u32(w.SMAA_EMIT),
    w.encodeString(name),
    w.encodeString(typeof value === "string" ? value : JSON.stringify(value)),
  ]);
  return Buffer.concat([u32(body.length), body]);
}

/**
 * A minimal fake StagelinQ device on 127.0.0.1: a main port that performs
 * the services handshake, and a StateMap port that records subscriptions and
 * lets the test push values.
 */
async function startFakeDevice({ askFirst = true, host = "127.0.0.1" } = {}) {
  const token = Buffer.alloc(16, 0x42);
  const subscriptions = [];
  const stateSockets = new Set();

  const stateServer = net.createServer((sock) => {
    stateSockets.add(sock);
    let buf = Buffer.alloc(0);
    let announced = false;
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!announced) {
        // raw announcement: id(4) + token(16) + string + port(2)
        const s = w.readString(buf, 20, 1000);
        if (!s || buf.length < s.next + 2) return;
        announced = true;
        buf = buf.subarray(s.next + 2);
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const frame = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        subscriptions.push(w.readString(frame, 8, 1000).value);
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => stateSockets.delete(sock));
  });
  await new Promise((r) => stateServer.listen(0, host, r));
  const statePort = stateServer.address().port;

  const mainSockets = new Set();
  const mainServer = net.createServer((sock) => {
    mainSockets.add(sock);
    if (askFirst) sock.write(w.encodeServicesRequest(token));
    const parser = new w.MainStreamParser();
    sock.on("data", (chunk) => {
      for (const m of parser.push(chunk)) {
        if (m.type === "services-request") {
          sock.write(
            Buffer.concat([
              w.encodeServiceAnnouncement(token, "FileTransfer", 1),
              w.encodeServiceAnnouncement(token, "StateMap", statePort),
              w.encodeReference(token, Buffer.alloc(16), 0n),
            ])
          );
        }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => mainSockets.delete(sock));
  });
  await new Promise((r) => mainServer.listen(0, host, r));

  return {
    device: {
      id: token.toString("hex"),
      token,
      address: host,
      port: mainServer.address().port,
      name: "fake",
      software: "JC11",
      version: "0.0.0",
    },
    subscriptions,
    emit(name, value) {
      for (const s of stateSockets) s.write(emitFrame(name, value));
    },
    writeRaw(bytes) {
      for (const s of stateSockets) s.write(bytes);
    },
    dropConnections() {
      for (const s of [...mainSockets, ...stateSockets]) s.destroy();
    },
    async close() {
      for (const s of [...mainSockets, ...stateSockets]) s.destroy();
      await Promise.all([
        new Promise((r) => mainServer.close(r)),
        new Promise((r) => stateServer.close(r)),
      ]);
    },
  };
}

module.exports = { startFakeDevice, emitFrame };
