"use strict";

const { LinkError } = require("./errors");
const { validateApiUrl } = require("./config");

const SYNC_SOURCE = "engine-dj";

/**
 * Thin client for the DJRequest.me Developer API.
 * `fetchImpl` is injectable for tests; defaults to the global fetch.
 */
function createApiClient({ apiUrl, apiKey, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new LinkError("No fetch implementation available.", "NO_FETCH");
  }
  // Re-validated here (not just in the CLI) so no caller can send the key over
  // plain HTTP to a remote host.
  const base = validateApiUrl(apiUrl);

  async function rawFetch(method, url, init = {}) {
    try {
      return await doFetch(url, { method, ...init });
    } catch (err) {
      throw new LinkError(`Could not reach the API (${url}): ${err.message}`, "NETWORK");
    }
  }

  // POST JSON and parse a JSON response, mapping every failure mode to a clear
  // LinkError — including non-JSON (HTML) bodies, which happen when
  // --api-url is wrong or the endpoints are not deployed.
  async function postJson(path, body) {
    const url = `${base}${path}`;
    const res = await rawFetch("POST", url, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    const data = tryParseJson(text);

    if (!res.ok) {
      const message =
        (data && (data.error || data.message)) || describeNonJson(text, res, url);
      throw mapApiError(res.status, message);
    }

    if (data === undefined) {
      throw new LinkError(
        `Expected JSON from ${url} but received ${nonJsonKind(text)} (HTTP ${res.status}). ` +
          "Check that --api-url is correct and that the catalogue sync endpoints are deployed.",
        "BAD_RESPONSE"
      );
    }

    return data;
  }

  return {
    requestUploadUrl({ fileName, fileSize, sha256, trackCount, playlistPaths }) {
      return postJson("/api/v1/catalogue/sync/upload-url", {
        source: SYNC_SOURCE,
        fileName,
        fileSize,
        sha256,
        trackCount,
        playlistPaths,
      });
    },

    // The signed storage URL carries its own auth: never send the API key to it.
    async putEnvelope(uploadUrl, contentType, bytes) {
      assertSecureUploadUrl(uploadUrl);
      const res = await rawFetch("PUT", uploadUrl, {
        headers: { "Content-Type": contentType },
        body: bytes,
      });
      if (!res.ok) {
        throw new LinkError(
          `Upload to storage failed (HTTP ${res.status}). The signed URL may have expired or the content type did not match.`,
          "UPLOAD_FAILED"
        );
      }
    },

    finalize({ objectPath, sha256, trackCount, playlistPaths }) {
      return postJson("/api/v1/catalogue/sync/finalize", {
        objectPath,
        source: SYNC_SOURCE,
        sha256,
        trackCount,
        playlistPaths,
      });
    },
  };
}

function assertSecureUploadUrl(uploadUrl) {
  let url;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new LinkError("The server returned an invalid upload URL.", "BAD_RESPONSE");
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new LinkError(
      `Refusing to upload your catalogue to a non-HTTPS URL (${url.protocol}//${url.host}).`,
      "INSECURE_URL"
    );
  }
}

function tryParseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function nonJsonKind(text) {
  const trimmed = (text || "").trimStart();
  if (/^<(?:!doctype|html|\?xml|\w)/i.test(trimmed)) return "an HTML/XML page";
  if (!trimmed) return "an empty response";
  return "a non-JSON response";
}

function describeNonJson(text, res, url) {
  if (nonJsonKind(text) === "an HTML/XML page") {
    return `non-JSON HTML response — the sync endpoint may not exist at ${url}`;
  }
  return res.statusText || `HTTP ${res.status}`;
}

function mapApiError(status, message) {
  if (status === 401) {
    return new LinkError(
      `API authentication failed (401). Check your --api-key. ${message}`.trim(),
      "API_AUTH"
    );
  }
  if (status === 403) {
    return new LinkError(`API request forbidden (403): ${message}`, "API_FORBIDDEN");
  }
  if (status === 404) {
    return new LinkError(
      `API endpoint not found (404): ${message}. Is --api-url correct and the sync endpoints deployed?`,
      "API_NOT_FOUND"
    );
  }
  if (status === 429) {
    return new LinkError("API rate limited (429). Wait a minute and retry.", "API_RATE_LIMITED");
  }
  if (status >= 400 && status < 500) {
    return new LinkError(message || `API request failed (${status}).`, "API_BAD_REQUEST");
  }
  return new LinkError(`API error (${status}): ${message}`, "API_ERROR");
}

module.exports = { createApiClient };
