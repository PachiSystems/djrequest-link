"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateApiUrl,
  resolveApiUrl,
  resolveApiKey,
  DEFAULT_API_URL,
} = require("../src/config");

test("validateApiUrl accepts https and normalizes trailing slashes", () => {
  assert.equal(validateApiUrl("https://djrequest.me/"), "https://djrequest.me");
  assert.equal(validateApiUrl("https://app.example.com/base//"), "https://app.example.com/base");
  assert.equal(validateApiUrl("  https://djrequest.me  "), "https://djrequest.me");
});

test("validateApiUrl allows plain http only for localhost", () => {
  assert.equal(validateApiUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(validateApiUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(validateApiUrl("http://[::1]:3000"), "http://[::1]:3000");
  assert.throws(() => validateApiUrl("http://djrequest.me"), /plain HTTP/);
  assert.throws(() => validateApiUrl("http://localhost.evil.example"), /plain HTTP/);
});

test("validateApiUrl rejects credentials, query strings, other schemes, and junk", () => {
  assert.throws(() => validateApiUrl("https://user:pw@djrequest.me"), /username or password/);
  assert.throws(() => validateApiUrl("https://djrequest.me/?x=1"), /query string/);
  assert.throws(() => validateApiUrl("https://djrequest.me/#frag"), /fragment/);
  assert.throws(() => validateApiUrl("ftp://djrequest.me"), /https/);
  assert.throws(() => validateApiUrl("not a url"), /not a URL/);
});

test("resolveApiUrl: flag, then env, then default", () => {
  assert.equal(resolveApiUrl("https://a.example", { DJREQUEST_API_URL: "https://b.example" }), "https://a.example");
  assert.equal(resolveApiUrl(undefined, { DJREQUEST_API_URL: "https://b.example" }), "https://b.example");
  assert.equal(resolveApiUrl(undefined, {}), DEFAULT_API_URL);
});

test("resolveApiKey: flag, then env, else a helpful error", () => {
  assert.equal(resolveApiKey("flag-key", { DJREQUEST_API_KEY: "env-key" }), "flag-key");
  assert.equal(resolveApiKey(undefined, { DJREQUEST_API_KEY: " env-key " }), "env-key");
  assert.throws(() => resolveApiKey(undefined, {}), /DJREQUEST_API_KEY/);
});
