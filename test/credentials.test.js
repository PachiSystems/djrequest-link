"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createKeychain } = require("../src/credentials");

const KEY = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "https://www.djrequest.me";

/** Fake process runner: records calls, answers from a script. */
function fakeRun(answer) {
  const calls = [];
  const run = (command, args, input) => {
    calls.push({ command, args, input });
    return { status: 0, stdout: "", stderr: "", ...answer({ command, args, input }) };
  };
  run.calls = calls;
  return run;
}

function assertKeyNotInArgs(run) {
  for (const c of run.calls) {
    const argv = [c.command, ...c.args].join(" ");
    assert.equal(argv.includes(KEY), false, `key leaked into argv: ${c.command}`);
    // Windows passes the script base64-encoded; decode and check that too.
    const i = c.args.indexOf("-EncodedCommand");
    if (i !== -1) {
      const script = Buffer.from(c.args[i + 1], "base64").toString("utf16le");
      assert.equal(script.includes(KEY), false, "key leaked into the PowerShell script");
    }
  }
}

for (const platform of ["darwin", "linux", "win32"]) {
  test(`${platform}: set passes the key on stdin only`, () => {
    const run = fakeRun(() => ({}));
    createKeychain({ platform, run }).set(ACCOUNT, KEY);
    assert.equal(run.calls.length, 1);
    assert.ok(run.calls[0].input.includes(KEY), "key is on stdin");
    assertKeyNotInArgs(run);
  });

  test(`${platform}: get returns the stored key, or null when missing`, () => {
    const found = createKeychain({ platform, run: fakeRun(() => ({ stdout: `${KEY}\n` })) });
    assert.equal(found.get(ACCOUNT), KEY);

    const missing = createKeychain({
      platform,
      run: fakeRun(() => (platform === "darwin" ? { status: 44 } : platform === "linux" ? { status: 1 } : { stdout: "" })),
    });
    assert.equal(missing.get(ACCOUNT), null);
  });

  test(`${platform}: a missing helper binary is a clear error`, () => {
    const run = fakeRun(() => ({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), status: null }));
    assert.throws(() => createKeychain({ platform, run }).get(ACCOUNT), (err) => {
      assert.equal(err.code, "KEYCHAIN_UNAVAILABLE");
      assert.match(err.message, /ENOENT/);
      return true;
    });
  });
}

test("darwin: account and service are passed as separate argv entries", () => {
  const run = fakeRun(() => ({ stdout: KEY }));
  createKeychain({ platform: "darwin", run }).get(ACCOUNT);
  assert.deepEqual(run.calls[0].args, ["find-generic-password", "-a", ACCOUNT, "-s", "djrequest-link", "-w"]);
});

test("keys with unexpected characters are refused before reaching a helper", () => {
  const run = fakeRun(() => ({}));
  const kc = createKeychain({ platform: "darwin", run });
  assert.throws(() => kc.set(ACCOUNT, 'abc" ; delete-keychain x'), /doesn't look like/);
  assert.throws(() => kc.set(ACCOUNT, "short"), /doesn't look like/);
  assert.equal(run.calls.length, 0);
});

test("unsupported platforms report no keychain and fail clearly on set", () => {
  const kc = createKeychain({ platform: "aix", run: fakeRun(() => ({})) });
  assert.equal(kc.supported, false);
  assert.equal(kc.get(ACCOUNT), null);
  assert.throws(() => kc.set(ACCOUNT, KEY), /DJREQUEST_API_KEY/);
});

// Real round-trip against the OS keychain. Opt-in (CI sets it on macOS and
// Windows) so running the suite never touches a developer's keychain.
test(
  "real OS keychain round-trip",
  { skip: process.env.DJREQUEST_KEYCHAIN_SELFTEST !== "1" && "set DJREQUEST_KEYCHAIN_SELFTEST=1" },
  () => {
    const kc = createKeychain();
    const account = `https://selftest-${process.pid}.invalid`;
    try {
      assert.equal(kc.get(account), null);
      kc.set(account, KEY);
      assert.equal(kc.get(account), KEY);
    } finally {
      kc.remove(account);
    }
    assert.equal(kc.get(account), null);
  }
);
