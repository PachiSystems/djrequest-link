"use strict";

const { spawnSync } = require("node:child_process");
const { LinkError } = require("./errors");

/**
 * OS keychain storage for the Developer API key, with zero dependencies:
 *
 *   macOS    /usr/bin/security (login keychain)
 *   Linux    secret-tool (libsecret: GNOME Keyring, KWallet via the portal)
 *   Windows  Credential Manager, via PowerShell calling advapi32 CredRead/Write
 *
 * The key is ALWAYS passed to the helper on stdin — never as a command-line
 * argument, where any local user could read it from the process list.
 *
 * Keys are stored per API base URL (the "account"), so a localhost dev key and
 * a production key don't overwrite each other.
 */

const SERVICE = "djrequest-link";
// Generous: the Windows helper compiles a small C# type on first use, which
// can take ~20 s on a cold, slow machine.
const TIMEOUT_MS = 60_000;

// Keys are UUIDs today. Anything outside this conservative set is refused
// before it reaches a helper's stdin (macOS `security -i` parses a command line).
const KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{8,512}$/;

function assertStorableKey(key) {
  if (!KEY_PATTERN.test(key)) {
    throw new LinkError(
      "That doesn't look like a DJRequest.me API key (unexpected characters or length).",
      "BAD_ARGS"
    );
  }
}

function defaultRun(command, args, input) {
  return spawnSync(command, args, {
    input,
    encoding: "utf-8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
}

// ---- macOS ------------------------------------------------------------------

function macBackend(run) {
  const SECURITY = "/usr/bin/security";
  const quote = (s) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  return {
    name: "macOS Keychain",
    get(account) {
      const r = run(SECURITY, ["find-generic-password", "-a", account, "-s", SERVICE, "-w"]);
      if (r.error) throw unavailable("macOS Keychain", r.error);
      if (r.status === 44) return null; // errSecItemNotFound
      if (r.status !== 0) throw failed("read", r);
      return r.stdout.replace(/\r?\n$/, "") || null;
    },
    set(account, key) {
      // `security -i` reads commands from stdin, keeping the key off argv.
      const cmd = `add-generic-password -U -a ${quote(account)} -s ${quote(SERVICE)} -l ${quote(`${SERVICE} (${account})`)} -w ${quote(key)}\n`;
      const r = run(SECURITY, ["-i"], cmd);
      if (r.error) throw unavailable("macOS Keychain", r.error);
      if (r.status !== 0 || /error/i.test(r.stderr || "")) throw failed("save", r);
    },
    remove(account) {
      const r = run(SECURITY, ["delete-generic-password", "-a", account, "-s", SERVICE]);
      if (r.error) throw unavailable("macOS Keychain", r.error);
      if (r.status === 44) return false;
      if (r.status !== 0) throw failed("remove", r);
      return true;
    },
  };
}

// ---- Linux ------------------------------------------------------------------

function linuxBackend(run) {
  const TOOL = "secret-tool";
  const attrs = (account) => ["service", SERVICE, "account", account];
  const check = (r) => {
    if (r.error) {
      throw unavailable(
        "the Secret Service (secret-tool)",
        r.error,
        " Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch), or use DJREQUEST_API_KEY."
      );
    }
  };
  return {
    name: "Secret Service",
    get(account) {
      const r = run(TOOL, ["lookup", ...attrs(account)]);
      check(r);
      if (r.status !== 0) return null; // not found (or locked keyring)
      return r.stdout.replace(/\r?\n$/, "") || null;
    },
    set(account, key) {
      const r = run(TOOL, ["store", `--label=${SERVICE} (${account})`, ...attrs(account)], key);
      check(r);
      if (r.status !== 0) throw failed("save", r);
    },
    remove(account) {
      const existed = this.get(account) !== null;
      const r = run(TOOL, ["clear", ...attrs(account)]);
      check(r);
      if (r.status !== 0) throw failed("remove", r);
      return existed;
    },
  };
}

// ---- Windows ----------------------------------------------------------------

// Compiled once per PowerShell invocation. Type=1 is CRED_TYPE_GENERIC and
// Persist=2 is CRED_PERSIST_LOCAL_MACHINE (this user, this machine; no roaming).
const WIN_CRED_TYPE = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DjrlCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr p);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try {
      Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static bool Delete(string target) { return CredDeleteW(target, 1, 0); }
}`;

function windowsBackend(run) {
  const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
  const target = (account) => `${SERVICE}:${account}`;
  const invoke = (body, input) => {
    const script =
      "$ErrorActionPreference = 'Stop'\n" +
      `Add-Type -TypeDefinition @'\n${WIN_CRED_TYPE}\n'@\n` +
      body;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const r = run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      input
    );
    if (r.error) throw unavailable("Windows Credential Manager", r.error);
    return r;
  };
  return {
    name: "Windows Credential Manager",
    get(account) {
      const r = invoke(
        `$v = [DjrlCred]::Read(${psQuote(target(account))}); if ($null -ne $v) { [Console]::Out.Write($v) }`
      );
      if (r.status !== 0) throw failed("read", r);
      return r.stdout.replace(/\r?\n$/, "") || null;
    },
    set(account, key) {
      const r = invoke(
        `$s = [Console]::In.ReadToEnd(); [DjrlCred]::Write(${psQuote(target(account))}, ${psQuote(SERVICE)}, $s)`,
        key
      );
      if (r.status !== 0) throw failed("save", r);
    },
    remove(account) {
      const r = invoke(`if ([DjrlCred]::Delete(${psQuote(target(account))})) { 'removed' }`);
      if (r.status !== 0) throw failed("remove", r);
      return /removed/.test(r.stdout);
    },
  };
}

// ---- Shared -----------------------------------------------------------------

function unavailable(what, error, hint = "") {
  return new LinkError(
    `Could not use ${what} (${error.code || error.message}).${hint}`,
    "KEYCHAIN_UNAVAILABLE"
  );
}

// Helper stderr never contains the key (it only ever arrives on stdin), but
// keep the message short anyway.
function failed(action, r) {
  const detail = String(r.stderr || "").trim().split(/\r?\n/)[0].slice(0, 200);
  return new LinkError(
    `Could not ${action} the API key in the OS keychain (exit ${r.status})${detail ? `: ${detail}` : ""}.`,
    "KEYCHAIN_FAILED"
  );
}

/**
 * @param {{ platform?: string, run?: Function }} [options] injectable for tests
 */
function createKeychain({ platform = process.platform, run = defaultRun } = {}) {
  let backend;
  if (platform === "darwin") backend = macBackend(run);
  else if (platform === "win32") backend = windowsBackend(run);
  else if (platform === "linux") backend = linuxBackend(run);
  else backend = null;

  return {
    name: backend ? backend.name : "none",
    supported: backend !== null,
    get(account) {
      return backend ? backend.get(account) : null;
    },
    set(account, key) {
      if (!backend) {
        throw new LinkError(
          `No OS keychain support on ${platform}. Use the DJREQUEST_API_KEY environment variable.`,
          "KEYCHAIN_UNAVAILABLE"
        );
      }
      assertStorableKey(key);
      backend.set(account, key);
    },
    remove(account) {
      return backend ? backend.remove(account) : false;
    },
  };
}

module.exports = { createKeychain, assertStorableKey, SERVICE };
