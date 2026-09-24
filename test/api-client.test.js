"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApiClient, parseRetryAfter } = require("../src/api-client");

const API_URL = "https://app.example.com";

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function recordingFetch(respond) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const call = { url: String(url), method: init.method, headers: init.headers || {}, body: init.body, redirect: init.redirect };
    calls.push(call);
    return respond(call);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("now-playing PUT/GET/DELETE hit the v1 venue routes with the key", async () => {
  const fetchImpl = recordingFetch((c) =>
    c.method === "DELETE" ? jsonResponse(200, { success: true }) : jsonResponse(200, { nowPlaying: null })
  );
  const client = createApiClient({ apiUrl: API_URL, apiKey: "k", fetchImpl });

  await client.setNowPlaying("venue 1/x", { trackTitle: "T", trackArtist: "A" });
  await client.getNowPlaying("venue 1/x");
  await client.clearNowPlaying("venue 1/x");

  const [put, get, del] = fetchImpl.calls;
  assert.equal(put.method, "PUT");
  assert.equal(put.url, `${API_URL}/api/v1/venues/venue%201%2Fx/now-playing`, "venue id is URL-encoded");
  assert.deepEqual(JSON.parse(put.body), { trackTitle: "T", trackArtist: "A" });
  assert.equal(put.headers.Authorization, "Bearer k");
  assert.equal(put.headers["Content-Type"], "application/json");
  assert.equal(get.method, "GET");
  assert.equal(get.body, undefined);
  assert.equal("Content-Type" in get.headers, false);
  assert.equal(del.method, "DELETE");
  for (const c of fetchImpl.calls) assert.equal(c.redirect, "manual");
});

test("a redirecting API URL is a clear error, never followed", async () => {
  const fetchImpl = recordingFetch(
    () =>
      new Response(null, {
        status: 308,
        headers: { location: "https://www.app.example.com/api/v1/venues" },
      })
  );
  const client = createApiClient({ apiUrl: API_URL, apiKey: "k", fetchImpl });
  await assert.rejects(client.listVenues(), (err) => {
    assert.equal(err.code, "API_REDIRECT");
    assert.match(err.message, /redirects \(HTTP 308\) to https:\/\/www\.app\.example\.com\./);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test("429 carries Retry-After in milliseconds", async () => {
  const fetchImpl = recordingFetch(() =>
    jsonResponse(429, { error: "Too many requests" }, { "retry-after": "12" })
  );
  const client = createApiClient({ apiUrl: API_URL, apiKey: "k", fetchImpl });
  await assert.rejects(client.setNowPlaying("v", { trackTitle: "T", trackArtist: "A" }), (err) => {
    assert.equal(err.code, "API_RATE_LIMITED");
    assert.equal(err.retryAfterMs, 12000);
    return true;
  });
});

test("404 on a venue explains itself", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(404, { error: "Venue not found" }));
  const client = createApiClient({ apiUrl: API_URL, apiKey: "k", fetchImpl });
  await assert.rejects(client.getVenue("nope"), /Venue not found/);
});

test("a missing venue id is rejected before any request", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, {}));
  const client = createApiClient({ apiUrl: API_URL, apiKey: "k", fetchImpl });
  await assert.rejects(client.getVenue("  "), /venue id is required/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("parseRetryAfter handles seconds, dates, and junk", () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(parseRetryAfter(null), undefined);
});
