"use strict";

const { LinkError } = require("./errors");

const CTRL_C = 3;
const BACKSPACE = 8;
const LF = 10;
const CR = 13;
const DEL = 127;

/**
 * Read a secret without echoing it. On a terminal, the typed characters are
 * not shown; when stdin is piped (`... | djrequest-link auth set-key`), the
 * whole of stdin is read instead.
 */
function readSecret(message, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return readAll(input);

  return new Promise((resolve, reject) => {
    let value = "";
    output.write(message);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();

    const finish = (err) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };

    function onData(chunk) {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === CR || code === LF) return finish();
        if (code === CTRL_C) return finish(new LinkError("Cancelled.", "CANCELLED"));
        if (code === BACKSPACE || code === DEL) value = value.slice(0, -1);
        else if (code >= 32) value += ch;
      }
    }
    input.on("data", onData);
  });
}

function readAll(input) {
  return new Promise((resolve, reject) => {
    let data = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      data += chunk;
      if (data.length > 4096) reject(new LinkError("Input too long for an API key.", "BAD_ARGS"));
    });
    input.on("end", () => resolve(data.trim()));
    input.on("error", reject);
  });
}

module.exports = { readSecret };
