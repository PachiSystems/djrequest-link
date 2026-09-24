"use strict";

const { parseArgs } = require("node:util");
const { LinkError } = require("../errors");
const { resolveApiUrl, resolveApiKey } = require("../config");
const { createKeychain } = require("../credentials");
const { createApiClient } = require("../api-client");

const ENV_VENUE_ID = "DJREQUEST_VENUE_ID";

/** Options shared by every command that talks to the API. */
const API_OPTIONS = {
  "api-url": { type: "string" },
  "api-key": { type: "string" },
};

const out = (s = "") => process.stdout.write(`${s}\n`);
const warn = (message) => process.stderr.write(`Warning: ${message}\n`);

function parse(args, options) {
  try {
    return parseArgs({ args, options, allowPositionals: false }).values;
  } catch (err) {
    throw new LinkError(err.message, "BAD_ARGS");
  }
}

function requireOption(value, name) {
  if (!value) throw new LinkError(`Missing required option ${name}.`, "BAD_ARGS");
}

/** The OS keychain, unless disabled with DJREQUEST_NO_KEYCHAIN=1. */
function keychain() {
  return process.env.DJREQUEST_NO_KEYCHAIN === "1" ? null : createKeychain();
}

/** Resolve URL + key and build an API client. */
function apiFromOptions(values) {
  const apiUrl = resolveApiUrl(values["api-url"]);
  const apiKey = resolveApiKey(values["api-key"], { keychain: keychain(), apiUrl });
  return { apiUrl, api: createApiClient({ apiUrl, apiKey }) };
}

function venueFromOptions(values) {
  const venueId = (values.venue || process.env[ENV_VENUE_ID] || "").trim();
  if (!venueId) {
    throw new LinkError(
      `Missing venue. Pass --venue <id> or set ${ENV_VENUE_ID}. ` +
        "Run `djrequest-link venues list` to see your venue ids.",
      "BAD_ARGS"
    );
  }
  return venueId;
}

module.exports = {
  API_OPTIONS,
  ENV_VENUE_ID,
  out,
  warn,
  parse,
  requireOption,
  keychain,
  apiFromOptions,
  venueFromOptions,
};
