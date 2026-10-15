#!/usr/bin/env tsx
/**
 * durable-admit CLI — copy ONE closed pi-durable snapshot into the session
 * corpus (issue #15). The snapshot must already exist, made through an
 * approved procedure; this never finds, opens or snapshots a live DB.
 *
 * Usage:
 *   durable-admit <closed snapshot> --device <roster id> [--bucket <24hex>] [--session <13digits-uuid>] [--json]
 *
 * Holds the shared sessions writer lock (sessions-lock.ts) while it writes.
 * Exit: 0 created/replaced/unchanged, 2 usage, 3 refused (reason printed by name), 75 writer lock held.
 */

import * as path from "node:path";
import { DurableReadRefused } from "../durable-reader.ts";
import { admitDurableSnapshot, DurableAdmitRefused } from "../durable-source.ts";
import { SessionsLockRefused, withSessionsLock } from "../sessions-lock.ts";

const USAGE = [
  "usage: corpus:durable-admit <closed snapshot> --device <roster id> [--bucket <24hex>] [--session <13digits-uuid>] [--json]",
  "",
  "Copies ONE closed snapshot (made beforehand through an approved procedure) to",
  "  $ANDENKEN_SESSION_CORPUS/<device>/.pi/agent/experimental/durable-sessions/<bucket>/<session>/session.sqlite",
  "as a real copy (0600, new directories 0700) with an atomic rename. A live DB is refused before it is opened.",
  "Replacing a corpus copy needs the same lineage, the old last entry unchanged, and no fewer entries.",
].join("\n");

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.error(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  let input: string | undefined;
  let device: string | undefined;
  let bucket: string | undefined;
  let session: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--device") device = args[++i];
    else if (a === "--bucket") bucket = args[++i];
    else if (a === "--session") session = args[++i];
    else if (a === "--json") json = true;
    else if (!a.startsWith("--") && input === undefined) input = a;
    else {
      console.error(`unexpected argument: ${a}\n\n${USAGE}`);
      return 2;
    }
  }
  if (!input || !device) {
    console.error(USAGE);
    return 2;
  }
  // A corpus replacement must not overlap an index:durable reading that copy.
  const report = await withSessionsLock("corpus:durable-admit", () =>
    admitDurableSnapshot({
      input: path.resolve(process.env.DURABLE_CALLER_CWD ?? process.cwd(), input),
      device: device!,
      bucket,
      session,
    }),
  );
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.action.toUpperCase()} ${report.dest}`);
    console.log(`  sha256=${report.sha256} maxEntryId=${report.maxEntryId} lineage=${report.lineage ?? "unknown"}`);
    if (report.previous) console.log(`  previous sha256=${report.previous.sha256} maxEntryId=${report.previous.maxEntryId}`);
    for (const n of report.notes) console.log(`  note: ${n}`);
    if (report.action !== "unchanged") console.log("  next: ./run.sh corpus:manifest update");
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof SessionsLockRefused) {
      console.error(`REFUSED ${err.message}`);
      process.exit(err.exitCode);
    }
    if (err instanceof DurableAdmitRefused || err instanceof DurableReadRefused) {
      console.error(`REFUSED ${err.reason}: ${err.detail}`);
      if (process.argv.includes("--json")) console.log(JSON.stringify({ refused: { reason: err.reason, detail: err.detail } }));
      process.exit(3);
    }
    console.error(err);
    process.exit(1);
  },
);
