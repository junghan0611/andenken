#!/usr/bin/env tsx
/**
 * durable-plan CLI — API-0 embedding plan for one CLOSED pi-durable snapshot (issue #15).
 *
 * Not an indexer: no embedding call, no store, no manifest, no write. It prints
 * what two candidate admission policies (B human-run, C root/fork assistant)
 * would do with each entry, with a basis, a hold watermark and token estimates.
 * Entry text is never printed; read a candidate with durable:read --around.
 *
 * Usage: durable-plan <session.sqlite> [--json]
 * Exit: 0 ok, 2 usage, 3 refused (reason printed by name).
 */

import * as path from "node:path";
import { DurableReadRefused } from "../durable-reader.ts";
import { planDurable, renderDurablePlan } from "../durable-plan.ts";

const USAGE = [
  "usage: durable:plan <session.sqlite> [--json]",
  "",
  "API 0 — prints an embedding PLAN; nothing is written, embedded or indexed.",
  "Closed snapshots only — a live session DB is refused before it is opened.",
].join("\n");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.error(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  if (rest.length !== 1 || rest[0].startsWith("--")) {
    console.error(`unexpected arguments: ${rest.join(" ")}\n\n${USAGE}`);
    return 2;
  }
  const file = path.resolve(process.env.DURABLE_CALLER_CWD ?? process.cwd(), rest[0]);
  const plan = await planDurable(file);
  console.log(json ? JSON.stringify(plan, null, 2) : renderDurablePlan(plan));
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
    console.error(err);
    process.exit(1);
  },
);
