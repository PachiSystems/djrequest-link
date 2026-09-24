"use strict";

const { LinkError } = require("../errors");
const { resolveApiUrl, findApiKey, ENV_API_KEY } = require("../config");
const { assertStorableKey } = require("../credentials");
const { createApiClient } = require("../api-client");
const { readSecret } = require("../prompt");
const { API_OPTIONS, out, parse, keychain } = require("./shared");

const HELP = `djrequest-link auth — manage your Developer API key.

Usage:
  djrequest-link auth set-key    [--api-url <url>] [--no-verify]
  djrequest-link auth status     [--api-url <url>] [--check]
  djrequest-link auth remove-key [--api-url <url>]

set-key prompts for the key without echoing it (or reads it from stdin when
piped), checks it against the API, and stores it in your OS keychain:
macOS Keychain, Windows Credential Manager, or the Linux Secret Service
(secret-tool). Keys are stored per --api-url.

Where the key is looked up, in order:
  1. --api-key <key>            (avoid: ends up in shell history)
  2. ${ENV_API_KEY}             (environment variable)
  3. the OS keychain entry for the API URL

Options:
  --no-verify   (set-key) Store without checking the key against the API.
  --check       (status)  Also check the key against the API.
`;

const mask = (key) => (key.length > 8 ? `…${key.slice(-4)}` : "…");

function requireKeychain() {
  const kc = keychain();
  if (!kc) throw new LinkError("The OS keychain is disabled (DJREQUEST_NO_KEYCHAIN=1).", "KEYCHAIN_UNAVAILABLE");
  if (!kc.supported) {
    throw new LinkError(`No OS keychain support on this platform. Use ${ENV_API_KEY} instead.`, "KEYCHAIN_UNAVAILABLE");
  }
  return kc;
}

async function verify(apiUrl, apiKey) {
  const { venues } = await createApiClient({ apiUrl, apiKey }).listVenues();
  return Array.isArray(venues) ? venues.length : 0;
}

async function setKey(args) {
  const values = parse(args, { "api-url": API_OPTIONS["api-url"], "no-verify": { type: "boolean", default: false } });
  const apiUrl = resolveApiUrl(values["api-url"]);
  const kc = requireKeychain();

  const key = await readSecret(`Paste your DJRequest.me API key for ${apiUrl} (input hidden): `);
  if (!key) throw new LinkError("No key entered.", "BAD_ARGS");
  assertStorableKey(key);

  if (!values["no-verify"]) {
    const count = await verify(apiUrl, key);
    out(`Key works: ${count} venue(s) on this account.`);
  }
  kc.set(apiUrl, key);
  out(`Saved to ${kc.name} for ${apiUrl}.`);
}

async function status(args) {
  const values = parse(args, { ...API_OPTIONS, check: { type: "boolean", default: false } });
  const apiUrl = resolveApiUrl(values["api-url"]);
  const found = findApiKey(values["api-key"], { keychain: keychain(), apiUrl });

  out(`API URL: ${apiUrl}`);
  if (!found) {
    out("API key: not set. Run `djrequest-link auth set-key`.");
    process.exitCode = 1;
    return;
  }
  const where = { flag: "--api-key flag", env: ENV_API_KEY, keychain: "OS keychain" }[found.source];
  out(`API key: ${mask(found.key)} (from ${where})`);
  if (values.check) {
    const count = await verify(apiUrl, found.key);
    out(`Key works: ${count} venue(s) on this account.`);
  }
}

async function removeKey(args) {
  const values = parse(args, { "api-url": API_OPTIONS["api-url"] });
  const apiUrl = resolveApiUrl(values["api-url"]);
  const removed = requireKeychain().remove(apiUrl);
  out(removed ? `Removed the stored key for ${apiUrl}.` : `No stored key for ${apiUrl}.`);
}

module.exports = {
  HELP,
  commands: { "set-key": setKey, status, "remove-key": removeKey },
};
