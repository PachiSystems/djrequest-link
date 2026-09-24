"use strict";

/**
 * StagelinQ wire format: pure encode/decode, no I/O.
 *
 * Protocol knowledge comes from the MIT-licensed open implementations
 * icedream/go-stagelinq and chrisle/StageLinq (see THIRD_PARTY_NOTICES.md).
 * This is an independent, minimal implementation of the parts we need:
 * UDP discovery, the main-connection service handshake, and StateMap
 * subscriptions.
 *
 * Everything here parses data straight off the local network, so it is
 * treated as untrusted: every length is bounds-checked before use and
 * oversized or malformed input is rejected rather than allocated.
 *
 * Encoding notes:
 *   - integers are big-endian
 *   - a "network string" is a uint32 byte length followed by UTF-16BE text
 *   - tokens are 16 opaque bytes identifying a device/application
 */

const { randomBytes } = require("node:crypto");

const DISCOVERY_PORT = 51337;
const DISCOVERY_MAGIC = Buffer.from("airD", "latin1");
const SMAA_MAGIC = Buffer.from("smaa", "latin1");
const TOKEN_BYTES = 16;

const ACTION_HOWDY = "DISCOVERER_HOWDY_";
const ACTION_EXIT = "DISCOVERER_EXIT_";

// Main-connection message ids.
const MSG_SERVICE_ANNOUNCEMENT = 0x00000000;
const MSG_REFERENCE = 0x00000001;
const MSG_SERVICES_REQUEST = 0x00000002;

// StateMap ("smaa") frame types.
const SMAA_EMIT = 0x00000000;
const SMAA_SUBSCRIBE_RESPONSE = 0x000007d1;
const SMAA_SUBSCRIBE = 0x000007d2;

// Bounds for untrusted input.
const MAX_DISCOVERY_STRING_BYTES = 512;
const MAX_SERVICE_NAME_BYTES = 256;
const MAX_STATE_NAME_BYTES = 1024;
const MAX_STATE_JSON_BYTES = 16 * 1024;
const MAX_SMAA_FRAME_BYTES = 64 * 1024;

class WireError extends Error {
  constructor(message) {
    super(message);
    this.name = "WireError";
  }
}

/**
 * A random application token. Some Engine OS firmware rejects tokens whose
 * first byte has the high bit set, so it is always cleared.
 */
function makeToken() {
  const token = randomBytes(TOKEN_BYTES);
  token[0] &= 0x7f;
  return token;
}

// ---- Network strings ------------------------------------------------------

function encodeString(str) {
  const body = Buffer.from(String(str), "utf16le").swap16(); // → UTF-16BE
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

/**
 * Read a network string at `offset`.
 * @returns {{ value: string, next: number } | null} null when more bytes are needed
 * @throws {WireError} when the declared length is invalid or over `maxBytes`
 */
function readString(buf, offset, maxBytes) {
  if (buf.length < offset + 4) return null;
  const len = buf.readUInt32BE(offset);
  if (len % 2 !== 0) throw new WireError(`odd UTF-16 string length ${len}`);
  if (len > maxBytes) throw new WireError(`string length ${len} exceeds ${maxBytes}`);
  const start = offset + 4;
  if (buf.length < start + len) return null;
  const value = Buffer.from(buf.subarray(start, start + len)).swap16().toString("utf16le");
  return { value, next: start + len };
}

// ---- Discovery (UDP) ------------------------------------------------------

function encodeDiscovery({ token, source, action, softwareName, softwareVersion, port = 0 }) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  return Buffer.concat([
    DISCOVERY_MAGIC,
    token,
    encodeString(source),
    encodeString(action),
    encodeString(softwareName),
    encodeString(softwareVersion),
    portBuf,
  ]);
}

/**
 * Decode one discovery datagram. Returns null for anything that is not a
 * well-formed StagelinQ announcement (other apps also use port 51337).
 */
function decodeDiscovery(buf) {
  try {
    if (buf.length < 4 + TOKEN_BYTES || !buf.subarray(0, 4).equals(DISCOVERY_MAGIC)) return null;
    const token = Buffer.from(buf.subarray(4, 4 + TOKEN_BYTES));
    let offset = 4 + TOKEN_BYTES;
    const fields = [];
    for (let i = 0; i < 4; i++) {
      const s = readString(buf, offset, MAX_DISCOVERY_STRING_BYTES);
      if (!s) return null;
      fields.push(s.value);
      offset = s.next;
    }
    if (buf.length < offset + 2) return null;
    const port = buf.readUInt16BE(offset);
    const [source, action, softwareName, softwareVersion] = fields;
    if (action !== ACTION_HOWDY && action !== ACTION_EXIT) return null;
    return { token, source, action, softwareName, softwareVersion, port };
  } catch (err) {
    if (err instanceof WireError) return null;
    throw err;
  }
}

// ---- Main connection (TCP) -----------------------------------------------

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function encodeServicesRequest(token) {
  return Buffer.concat([u32(MSG_SERVICES_REQUEST), token]);
}

function encodeServiceAnnouncement(token, service, port) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  return Buffer.concat([u32(MSG_SERVICE_ANNOUNCEMENT), token, encodeString(service), portBuf]);
}

function encodeReference(token, targetToken, reference = 0n) {
  const ref = Buffer.alloc(8);
  ref.writeBigInt64BE(BigInt(reference));
  return Buffer.concat([u32(MSG_REFERENCE), token, targetToken, ref]);
}

/**
 * Incremental parser for the main connection, whose messages are NOT length
 * prefixed: each is a uint32 id followed by a fixed layout. Unknown ids mean
 * the stream is out of sync, which is fatal for the connection.
 */
class MainStreamParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** @returns {Array<object>} complete messages parsed from the stream so far */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const parsed = this.parseOne();
      if (!parsed) break;
      out.push(parsed.message);
      this.buf = this.buf.subarray(parsed.next);
    }
    if (this.buf.length > 64 * 1024) throw new WireError("main connection buffer overflow");
    return out;
  }

  parseOne() {
    const b = this.buf;
    if (b.length < 4 + TOKEN_BYTES) return null;
    const id = b.readUInt32BE(0);
    const token = Buffer.from(b.subarray(4, 4 + TOKEN_BYTES));
    const offset = 4 + TOKEN_BYTES;

    switch (id) {
      case MSG_SERVICE_ANNOUNCEMENT: {
        const s = readString(b, offset, MAX_SERVICE_NAME_BYTES);
        if (!s || b.length < s.next + 2) return null;
        return {
          message: { type: "service", token, service: s.value, port: b.readUInt16BE(s.next) },
          next: s.next + 2,
        };
      }
      case MSG_REFERENCE: {
        const end = offset + TOKEN_BYTES + 8;
        if (b.length < end) return null;
        return { message: { type: "reference", token }, next: end };
      }
      case MSG_SERVICES_REQUEST:
        return { message: { type: "services-request", token }, next: offset };
      default:
        throw new WireError(`unknown main-connection message id 0x${id.toString(16)}`);
    }
  }
}

// ---- StateMap (TCP) --------------------------------------------------------

function encodeSubscribe(path, interval = 0) {
  const body = Buffer.concat([SMAA_MAGIC, u32(SMAA_SUBSCRIBE), encodeString(path), u32(interval)]);
  return Buffer.concat([u32(body.length), body]);
}

/**
 * Incremental parser for the StateMap connection: uint32-length-prefixed
 * "smaa" frames. A frame with length 0 is a raw service announcement some
 * firmware sends first; it is skipped.
 */
class StateMapParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  /** @returns {Array<{type: "emit", name: string, json: string} | {type: "subscribed", name: string}>} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32BE(0);

      if (len === 0) {
        // Raw announcement: id 0 (already read as "len"), token, service, port.
        const s = readString(this.buf, 4 + TOKEN_BYTES, MAX_SERVICE_NAME_BYTES);
        if (!s || this.buf.length < s.next + 2) break;
        this.buf = this.buf.subarray(s.next + 2);
        continue;
      }

      if (len > MAX_SMAA_FRAME_BYTES) throw new WireError(`StateMap frame of ${len} bytes is too large`);
      if (this.buf.length < 4 + len) break;
      const frame = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const message = decodeSmaaFrame(frame);
      if (message) out.push(message);
    }
    return out;
  }
}

function decodeSmaaFrame(frame) {
  if (frame.length < 8 || !frame.subarray(0, 4).equals(SMAA_MAGIC)) {
    throw new WireError("StateMap frame without smaa magic");
  }
  const type = frame.readUInt32BE(4);
  const name = readString(frame, 8, MAX_STATE_NAME_BYTES);
  if (!name) throw new WireError("truncated StateMap frame");

  if (type === SMAA_EMIT) {
    const json = readString(frame, name.next, MAX_STATE_JSON_BYTES);
    if (!json) throw new WireError("truncated StateMap value");
    return { type: "emit", name: name.value, json: json.value };
  }
  if (type === SMAA_SUBSCRIBE_RESPONSE) {
    return { type: "subscribed", name: name.value };
  }
  return null; // other frame types are not used by a read-only subscriber
}

module.exports = {
  DISCOVERY_PORT,
  ACTION_HOWDY,
  ACTION_EXIT,
  TOKEN_BYTES,
  WireError,
  makeToken,
  encodeString,
  readString,
  encodeDiscovery,
  decodeDiscovery,
  encodeServicesRequest,
  encodeServiceAnnouncement,
  encodeReference,
  encodeSubscribe,
  MainStreamParser,
  StateMapParser,
  // exported for tests / fake devices
  SMAA_EMIT,
  SMAA_SUBSCRIBE,
  SMAA_SUBSCRIBE_RESPONSE,
  SMAA_MAGIC,
};
