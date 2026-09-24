"use strict";

const { API_OPTIONS, out, parse, apiFromOptions } = require("./shared");

const HELP = `djrequest-link venues — your venues on DJRequest.me.

Usage:
  djrequest-link venues list [--json]

Shows each venue's id — pass it to \`now-playing\` as --venue <id>, or set
DJREQUEST_VENUE_ID.
`;

async function list(args) {
  const values = parse(args, { ...API_OPTIONS, json: { type: "boolean", default: false } });
  const { api } = apiFromOptions(values);
  const { venues = [] } = await api.listVenues();

  if (values.json) {
    out(JSON.stringify(venues, null, 2));
    return;
  }
  if (venues.length === 0) {
    out("No venues on this account yet. Create one in your DJRequest.me admin.");
    return;
  }
  const idWidth = Math.max(2, ...venues.map((v) => String(v.id).length));
  out(`${"ID".padEnd(idWidth)}  ACTIVE  NAME`);
  for (const v of venues) {
    const where = v.location ? ` (${v.location})` : "";
    out(`${String(v.id).padEnd(idWidth)}  ${(v.isActive ? "yes" : "no").padEnd(6)}  ${v.name}${where}`);
  }
}

module.exports = { HELP, commands: { list } };
