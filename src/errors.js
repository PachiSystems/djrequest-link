"use strict";

/**
 * Typed error for djrequest-link. `code` lets the CLI map a failure to a clear,
 * actionable message and a non-zero exit code without leaking stack traces for
 * expected conditions (missing DB, unsupported schema, bad API key, etc.).
 */
class LinkError extends Error {
  constructor(message, code = "ERROR") {
    super(message);
    this.name = "LinkError";
    this.code = code;
  }
}

module.exports = { LinkError };
