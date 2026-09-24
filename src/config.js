"use strict";

const { LinkError } = require("./errors");

// The www host is canonical: https://djrequest.me 308-redirects to it, and a
// redirect to another host drops the Authorization header.
const DEFAULT_API_URL = "https://www.djrequest.me";
const ENV_API_URL = "DJREQUEST_API_URL";
const ENV_API_KEY = "DJREQUEST_API_KEY";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate and normalize the API base URL. The API key travels in an
 * Authorization header, so anything other than HTTPS is refused — except
 * plain http:// to localhost, for local development against `next dev`.
 * Credentials, query strings and fragments are rejected outright.
 *
 * @param {string} raw
 * @returns {string} normalized base URL without a trailing slash
 */
function validateApiUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new LinkError(`Invalid --api-url: "${raw}" is not a URL.`, "BAD_ARGS");
  }

  if (url.username || url.password) {
    throw new LinkError("--api-url must not contain a username or password.", "BAD_ARGS");
  }
  if (url.search || url.hash) {
    throw new LinkError("--api-url must not contain a query string or #fragment.", "BAD_ARGS");
  }

  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !isLocal) {
    throw new LinkError(
      `Refusing to send your API key over plain HTTP to ${url.host}. Use https:// ` +
        "(http:// is only allowed for localhost during development).",
      "INSECURE_URL"
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LinkError(`--api-url must be an https:// URL (got ${url.protocol}).`, "BAD_ARGS");
  }

  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** --api-url flag → DJREQUEST_API_URL → DEFAULT_API_URL, validated. */
function resolveApiUrl(flagValue, env = process.env) {
  return validateApiUrl(flagValue || env[ENV_API_URL] || DEFAULT_API_URL);
}

/**
 * Find the API key: --api-key flag → DJREQUEST_API_KEY → OS keychain entry for
 * this API URL. The key is never read from a positional argument, and this
 * tool only ever writes it to the OS keychain (via `auth set-key`).
 *
 * @returns {{ key: string, source: "flag" | "env" | "keychain" } | null}
 */
function findApiKey(flagValue, { env = process.env, keychain, apiUrl } = {}) {
  const flag = (flagValue || "").trim();
  if (flag) return { key: flag, source: "flag" };
  const fromEnv = (env[ENV_API_KEY] || "").trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (keychain && keychain.supported && apiUrl) {
    const stored = keychain.get(apiUrl);
    if (stored) return { key: stored, source: "keychain" };
  }
  return null;
}

/** Like findApiKey, but a missing key is an error that says how to fix it. */
function resolveApiKey(flagValue, options = {}) {
  const found = findApiKey(flagValue, options);
  if (!found) {
    throw new LinkError(
      "Missing API key. Run `djrequest-link auth set-key` to store it in your OS keychain, " +
        `or set ${ENV_API_KEY}. Find your key on the Developer page of your DJRequest.me admin.`,
      "BAD_ARGS"
    );
  }
  return found.key;
}

module.exports = {
  DEFAULT_API_URL,
  ENV_API_URL,
  ENV_API_KEY,
  validateApiUrl,
  resolveApiUrl,
  findApiKey,
  resolveApiKey,
};
