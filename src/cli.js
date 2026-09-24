"use strict";

const { LinkError } = require("./errors");
const { ENV_API_KEY, ENV_API_URL, DEFAULT_API_URL } = require("./config");
const { ENV_VENUE_ID } = require("./commands/shared");
const { version } = require("../package.json");

const GROUPS = {
  auth: require("./commands/auth"),
  venues: require("./commands/venues"),
  "now-playing": require("./commands/now-playing"),
  catalogue: require("./commands/catalogue"),
};

const HELP = `djrequest-link ${version} — local companion for DJRequest.me.

Usage:
  djrequest-link <group> <command> [options]
  djrequest-link <group> --help

Getting started:
  djrequest-link auth set-key                    Store your API key in the OS keychain
  djrequest-link venues list                     Find your venue id
  djrequest-link now-playing watch --venue <id>  Show what you're playing on the live display
  djrequest-link catalogue sync --db <m.db> --playlist <name>
                                                 Upload Engine DJ playlists as your catalogue

Groups:
  auth          Store, check or remove your Developer API key.
  venues        List your venues.
  now-playing   Follow Denon / Engine DJ gear over StagelinQ; set or clear Now Playing.
  catalogue     Sync Engine DJ playlists to your requestable catalogue.

Global options:
  --api-url <url>   DJRequest.me address. Falls back to ${ENV_API_URL}, then
                    ${DEFAULT_API_URL}. Must be https:// (http://localhost allowed).
  --api-key <key>   Developer API key. Prefer \`auth set-key\` or ${ENV_API_KEY}:
                    flags end up in your shell history.
  -h, --help        Show help.
  -v, --version     Show the version.

Environment:
  ${ENV_API_KEY}     API key (instead of the keychain)
  ${ENV_API_URL}     API base URL
  ${ENV_VENUE_ID}    Default venue for now-playing commands
  DJREQUEST_NO_KEYCHAIN=1  Never read the OS keychain
  DJREQUEST_DEBUG=1        Show stack traces on unexpected errors
`;

const isHelp = (arg) => arg === "--help" || arg === "-h" || arg === "help";

function run(argv = process.argv) {
  const [group, command, ...args] = argv.slice(2);

  if (group === undefined || isHelp(group)) {
    process.stdout.write(HELP);
    return;
  }
  if (group === "--version" || group === "-v") {
    process.stdout.write(`${version}\n`);
    return;
  }

  const mod = GROUPS[group];
  if (!mod) throw new LinkError(`Unknown command: ${group}. Run \`djrequest-link --help\`.`, "BAD_ARGS");

  if (command === undefined || isHelp(command) || args.some(isHelp)) {
    process.stdout.write(mod.HELP);
    return;
  }
  const handler = mod.commands[command];
  if (!handler) {
    throw new LinkError(
      `Unknown ${group} command: ${command}. Expected one of: ${Object.keys(mod.commands).join(", ")}.`,
      "BAD_ARGS"
    );
  }
  return handler(args);
}

async function main(argv = process.argv) {
  try {
    await run(argv);
  } catch (err) {
    if (err instanceof LinkError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

module.exports = { run, main, HELP };
