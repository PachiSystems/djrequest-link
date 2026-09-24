"use strict";

const { createHash } = require("node:crypto");

/** SHA-256 hex digest of a Buffer/string. */
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

module.exports = { sha256Hex };
