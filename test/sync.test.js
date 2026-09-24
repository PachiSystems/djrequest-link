"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInlineFixtureDb, cleanup } = require("./fixtures");
const { runSync } = require("../src/catalogue/sync");
const { sha256Hex } = require("../src/hash");

const API_URL = "https://app.example.com";
const API_KEY = "testkey";
const FIXED_NOW = () => new Date("2026-06-02T00:00:00.000Z");
const UPLOAD_URL = "https://signed.example/put?sig=abc";
const OBJECT_PATH =
  "catalogue-sync/dj1/engine-dj/11111111-1111-4111-8111-111111111111/source.json";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(handlers) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const call = {
      url: String(url),
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body,
    };
    calls.push(call);
    for (const h of handlers) {
      if (h.match(call)) return h.respond(call);
    }
    throw new Error(`Unexpected fetch: ${call.method} ${call.url}`);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

const throwingFetch = () => {
  throw new Error("network must not be called");
};

function uploadHandlers() {
  return [
    {
      match: (c) => c.method === "POST" && c.url.endsWith("/api/v1/catalogue/sync/upload-url"),
      respond: () =>
        jsonResponse(200, {
          uploadUrl: UPLOAD_URL,
          objectPath: OBJECT_PATH,
          contentType: "application/json",
          expiresAt: Date.now() + 900000,
          maxBytes: 64 * 1024 * 1024,
        }),
    },
    {
      match: (c) => c.method === "PUT" && c.url === UPLOAD_URL,
      respond: () => new Response(null, { status: 200 }),
    },
    {
      match: (c) => c.method === "POST" && c.url.endsWith("/api/v1/catalogue/sync/finalize"),
      respond: () =>
        jsonResponse(200, {
          success: true,
          trackCount: 2,
          source: "engine-dj",
          playlistCount: 1,
          hash: "server-echo",
        }),
    },
  ];
}

function baseOptions(fx, overrides = {}) {
  return {
    dbPath: fx.dbPath,
    apiUrl: API_URL,
    apiKey: API_KEY,
    playlists: ["All"],
    manifestPath: path.join(fx.dir, "manifest.json"),
    now: FIXED_NOW,
    ...overrides,
  };
}

test("dry-run computes hash/counts and makes no network calls or manifest", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));
  const opts = baseOptions(fx, { dryRun: true, fetchImpl: throwingFetch });

  const outcome = await runSync(opts);

  assert.equal(outcome.status, "dry-run");
  assert.equal(outcome.trackCount, 2);
  assert.equal(outcome.playlistCount, 1);
  assert.ok(outcome.sizeBytes > 0);
  assert.match(outcome.hash, /^[0-9a-f]{64}$/);
  assert.equal(outcome.wouldSkip, false);
  assert.equal(fs.existsSync(opts.manifestPath), false);
});

test("changed library uploads in order and writes the manifest", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));

  // Hash the same way runSync does, via a no-network dry-run.
  const dry = await runSync(baseOptions(fx, { dryRun: true, fetchImpl: throwingFetch }));
  const expectedHash = dry.hash;

  const fetchImpl = recordingFetch(uploadHandlers());
  const opts = baseOptions(fx, { fetchImpl });
  const outcome = await runSync(opts);

  assert.equal(outcome.status, "synced");
  assert.equal(outcome.hash, expectedHash);
  assert.equal(outcome.trackCount, 2);

  // Three calls in the required order.
  assert.equal(fetchImpl.calls.length, 3);
  const [uploadUrlCall, putCall, finalizeCall] = fetchImpl.calls;

  assert.equal(uploadUrlCall.method, "POST");
  assert.ok(uploadUrlCall.url.endsWith("/api/v1/catalogue/sync/upload-url"));
  assert.equal(uploadUrlCall.headers.Authorization, "Bearer testkey");
  const uploadBody = JSON.parse(uploadUrlCall.body);
  assert.equal(uploadBody.source, "engine-dj");
  assert.equal(uploadBody.sha256, expectedHash);
  assert.equal(uploadBody.trackCount, 2);
  assert.ok(uploadBody.fileSize > 0);
  assert.deepEqual(uploadBody.playlistPaths, ["All"]);

  assert.equal(putCall.method, "PUT");
  assert.equal(putCall.url, UPLOAD_URL);
  assert.equal(putCall.headers["Content-Type"], "application/json");
  assert.equal("Authorization" in putCall.headers, false, "API key must not go to storage");
  // The bytes PUT must hash to the declared sha256.
  assert.equal(sha256Hex(putCall.body), expectedHash);

  assert.equal(finalizeCall.method, "POST");
  assert.ok(finalizeCall.url.endsWith("/api/v1/catalogue/sync/finalize"));
  const finalizeBody = JSON.parse(finalizeCall.body);
  assert.equal(finalizeBody.objectPath, OBJECT_PATH);
  assert.equal(finalizeBody.sha256, expectedHash);
  assert.equal(finalizeBody.trackCount, 2);
  assert.deepEqual(finalizeBody.playlistPaths, ["All"]);

  // Manifest written (no API key stored).
  const manifest = JSON.parse(fs.readFileSync(opts.manifestPath, "utf-8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.apiUrl, API_URL);
  assert.equal(manifest.lastHash, expectedHash);
  assert.equal(manifest.lastTrackCount, 2);
  assert.equal(manifest.lastSyncedAt, "2026-06-02T00:00:00.000Z");
  assert.deepEqual(manifest.playlistPaths, ["All"]);
  assert.equal("apiKey" in manifest, false);
});

test("unchanged library skips upload entirely", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));

  const dry = await runSync(baseOptions(fx, { dryRun: true, fetchImpl: throwingFetch }));
  const manifestPath = path.join(fx.dir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, apiUrl: API_URL, lastHash: dry.hash })
  );

  const outcome = await runSync(baseOptions(fx, { manifestPath, fetchImpl: throwingFetch }));
  assert.equal(outcome.status, "unchanged");
  assert.equal(outcome.hash, dry.hash);
});

test("--force re-uploads even when unchanged", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));

  const dry = await runSync(baseOptions(fx, { dryRun: true, fetchImpl: throwingFetch }));
  const manifestPath = path.join(fx.dir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, apiUrl: API_URL, lastHash: dry.hash })
  );

  const fetchImpl = recordingFetch(uploadHandlers());
  const outcome = await runSync(baseOptions(fx, { manifestPath, force: true, fetchImpl }));
  assert.equal(outcome.status, "synced");
  assert.equal(fetchImpl.calls.length, 3);
});

test("API auth failure surfaces a clear error", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));

  const fetchImpl = recordingFetch([
    {
      match: (c) => c.url.endsWith("/api/v1/catalogue/sync/upload-url"),
      respond: () => jsonResponse(401, { error: "Invalid API key" }),
    },
  ]);

  await assert.rejects(runSync(baseOptions(fx, { fetchImpl })), /authentication failed/i);
});

test("plan/track-limit failure from finalize surfaces the server message", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));

  const fetchImpl = recordingFetch([
    ...uploadHandlers().slice(0, 2), // upload-url + PUT succeed
    {
      match: (c) => c.url.endsWith("/api/v1/catalogue/sync/finalize"),
      respond: () =>
        jsonResponse(400, {
          error: "Catalogue has 46000 tracks but your Pro plan allows 25000",
        }),
    },
  ]);

  await assert.rejects(runSync(baseOptions(fx, { fetchImpl })), /plan allows 25000/);
});

test("HTML response (wrong URL / endpoints not deployed) yields a clear error", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));

  const fetchImpl = recordingFetch([
    {
      match: (c) => c.url.endsWith("/api/v1/catalogue/sync/upload-url"),
      respond: () =>
        new Response("<!DOCTYPE html><html><body>Not found</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    },
  ]);

  await assert.rejects(
    runSync(baseOptions(fx, { fetchImpl })),
    /endpoints are deployed|HTML/i
  );
});

test("404 HTML surfaces an endpoint-not-found error (not a JSON crash)", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));

  const fetchImpl = recordingFetch([
    {
      match: (c) => c.url.endsWith("/api/v1/catalogue/sync/upload-url"),
      respond: () => new Response("<!DOCTYPE html>nope", { status: 404 }),
    },
  ]);

  await assert.rejects(runSync(baseOptions(fx, { fetchImpl })), /not found \(404\)/i);
});

test("network failure surfaces a reachability error", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));

  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };

  await assert.rejects(runSync(baseOptions(fx, { fetchImpl })), /Could not reach the API/);
});

test("refuses a plain-HTTP remote --api-url before any network call", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));
  await assert.rejects(
    runSync(baseOptions(fx, { apiUrl: "http://app.example.com", fetchImpl: throwingFetch })),
    /plain HTTP/
  );
});

test("refuses to PUT the catalogue to a non-HTTPS signed URL", async (t) => {
  const fx = createInlineFixtureDb();
  t.after(() => cleanup(fx.dir));
  const fetchImpl = recordingFetch([
    {
      match: (c) => c.url.endsWith("/api/v1/catalogue/sync/upload-url"),
      respond: () =>
        jsonResponse(200, {
          uploadUrl: "http://storage.example/put",
          objectPath: OBJECT_PATH,
          contentType: "application/json",
          maxBytes: 64 * 1024 * 1024,
        }),
    },
  ]);
  await assert.rejects(runSync(baseOptions(fx, { fetchImpl })), /non-HTTPS/);
  assert.equal(fetchImpl.calls.length, 1, "no PUT attempted");
});
