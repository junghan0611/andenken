#!/usr/bin/env tsx
/**
 * durable-read CLI — read a CLOSED pi-durable session snapshot (issue #15).
 *
 * Closed snapshot only: a live session DB (inside the live durable root, a hard
 * link, WAL header, or a -wal/-shm/-journal beside it) is refused by name
 * before it is opened. Take a snapshot with VACUUM INTO first.
 *
 * API 0. Network 0. Writes nothing.
 *
 * Usage:
 *   durable-read census <session.sqlite> [--json]
 *   durable-read read <session.sqlite> --around <entryId> [--before N] [--after N] [--max-chars N] [--json]
 *   durable-read read <session.sqlite> [--conversation C] [--from E] [--to E] [--limit N] [--max-chars N] [--json]
 *
 * Exit: 0 ok, 2 usage, 3 refused (reason printed by name).
 */

import * as path from "node:path";
import {
  censusDurable,
  DurableReadRefused,
  readDurableAround,
  readDurableRange,
  renderDurableRead,
} from "../durable-reader.ts";

const USAGE = [
  "usage:",
  "  durable:census <session.sqlite> [--json]",
  "  durable:read <session.sqlite> --around <entryId> [--before N] [--after N] [--max-chars N] [--json]",
  "  durable:read <session.sqlite> [--conversation C] [--from E] [--to E] [--limit N] [--max-chars N] [--json]",
  "",
  "Closed snapshots only — a live session DB is refused before it is opened.",
  "--around/--before/--after count physical entries of the center entry's own conversation.",
  "Range reads default to the root conversation (1) and a limit of 200; a cut range prints where to continue.",
].join("\n");

class UsageError extends Error {}

function intFlag(argv: string[], i: number, name: string, min: number): number {
  const v = Number(argv[i + 1]);
  if (!Number.isInteger(v) || v < min) throw new UsageError(`${name} needs an integer ≥ ${min}, got: ${argv[i + 1]}`);
  return v;
}

async function main(): Promise<number> {
  const [command, fileArg, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || !fileArg || fileArg === "--help" || fileArg === "-h") {
    console.error(USAGE);
    return command === "--help" || command === "-h" || fileArg === "--help" || fileArg === "-h" ? 0 : 2;
  }
  // run.sh changes into the repo before running tsx; resolve against where the caller stood.
  const file = path.resolve(process.env.DURABLE_CALLER_CWD ?? process.cwd(), fileArg);
  let json = false;
  let around: number | undefined;
  let before: number | undefined;
  let after: number | undefined;
  let conversationId: number | undefined;
  let from: number | undefined;
  let to: number | undefined;
  let limit: number | undefined;
  let maxChars: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") json = true;
    else if (a === "--around") (around = intFlag(rest, i, a, 1)), i++;
    else if (a === "--before") (before = intFlag(rest, i, a, 0)), i++;
    else if (a === "--after") (after = intFlag(rest, i, a, 0)), i++;
    else if (a === "--conversation") (conversationId = intFlag(rest, i, a, 1)), i++;
    else if (a === "--from") (from = intFlag(rest, i, a, 1)), i++;
    else if (a === "--to") (to = intFlag(rest, i, a, 1)), i++;
    else if (a === "--limit") (limit = intFlag(rest, i, a, 1)), i++;
    else if (a === "--max-chars") (maxChars = intFlag(rest, i, a, 1)), i++;
    else throw new UsageError(`unknown arg: ${a}`);
  }

  if (command === "census") {
    const census = await censusDurable(file);
    console.log(JSON.stringify(census, null, json ? 2 : 1));
    return 0;
  }
  if (command !== "read") throw new UsageError(`unknown command: ${command}`);
  if (around !== undefined && (conversationId !== undefined || from !== undefined || to !== undefined || limit !== undefined)) {
    throw new UsageError("--around does not combine with --conversation/--from/--to/--limit");
  }
  const result = around !== undefined
    ? await readDurableAround(file, around, before ?? 3, after ?? 3, { maxChars })
    : await readDurableRange(file, { conversationId, from, to, limit }, { maxChars });
  console.log(json ? JSON.stringify(result, null, 2) : renderDurableRead(result));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof DurableReadRefused) {
      console.error(`REFUSED ${err.reason}: ${err.detail}`);
      if (process.argv.includes("--json")) console.log(JSON.stringify({ refused: { reason: err.reason, detail: err.detail } }));
      process.exit(3);
    }
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  },
);
