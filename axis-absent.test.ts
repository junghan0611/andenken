#!/usr/bin/env tsx
/**
 * Fixture tests for the absent-axis invariant: A READ MUST NOT CREATE AN AXIS.
 *
 * API 0. No embedding call, no network. Everything runs against a scratch
 * `ANDENKEN_DATA`, which is the same instrument the bug was measured with.
 *
 * Why this file exists: the failure it covers is SILENT. On a writable host with
 * no index, the old read path created an empty dataset and answered
 * `{"count":0,"results":[]}` with exit 0 — a shape indistinguishable from an
 * honest "nothing matched" (sorge#1 C-b, measured thinkpad 2026-09-06). A live
 * run cannot tell the two apart, so only a fixture can. INVARIANT §8: a policy
 * added without a test change is assumed uncovered.
 *
 * Run it: `./run.sh test:absent`.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ok   ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andenken-absent-"));
const prev = process.env.ANDENKEN_DATA;
process.env.ANDENKEN_DATA = tmp;
process.env.ANDENKEN_INDEX_AUTHORITY = "test-authority";

// Imported AFTER ANDENKEN_DATA is set: the path helpers read the env at call
// time, but keeping the order explicit is what makes this file safe to reorder.
const {
	describeAxisAbsence,
	assertAxisPresent,
	isAxisAbsentError,
	axisNameForDbPath,
	getSessionsDbPath,
	getMdDbPath,
	getOpenclawDbPath,
	VectorStore,
	EXIT_AXIS_ABSENT,
} = await import("./store.ts");

try {
	console.log("\n🔒 absent axis — detection");

	ok("exit code for an absent axis is 4, not 0 and not 1", EXIT_AXIS_ABSENT === 4);
	ok("the axis is named by its file", axisNameForDbPath("/x/sessions.lance") === "sessions");

	for (const [axis, p] of [
		["sessions", getSessionsDbPath()],
		["md", getMdDbPath()],
		["openclaw", getOpenclawDbPath()],
	] as const) {
		const a = describeAxisAbsence(p);
		ok(`${axis}: a missing path is absent`, a !== null && a.axis === axis && a.state === "absent");
		ok(`${axis}: the answer names the authority`, a?.authority === "test-authority");
		ok(`${axis}: the answer says what to do next`, (a?.next.length ?? 0) > 0);
		// Off the authority the remedy is somewhere else, and the answer says so
		// instead of sending the caller to build an index it must not build.
		ok(`${axis}: off the authority it points at the authority host`, a?.next.includes("ask the authority host") ?? false);
	}

	// Same axis, same absence, DIFFERENT remedy — because remedy is a property of
	// (axis, host), not of the axis. This is why `state` stays one value: fixing a
	// second state value to the axis would hand a replica the authority's answer.
	process.env.ANDENKEN_INDEX_AUTHORITY = describeAxisAbsence(getMdDbPath())!.host;
	const onAuthority = describeAxisAbsence(getMdDbPath());
	ok("on the authority the remedy is to build it here", onAuthority?.next.includes("index:md") ?? false);
	ok("and the state value is still just absent", onAuthority?.state === "absent");
	ok("the discriminator is host vs authority, carried in the payload", onAuthority?.host === onAuthority?.authority);
	process.env.ANDENKEN_INDEX_AUTHORITY = "test-authority";

	// The residue case. A host that already ran the buggy read carries an empty
	// dataset directory; it must still be told it has no axis, or the bug's own
	// leftovers would silence the fix.
	const oc = getOpenclawDbPath();
	fs.mkdirSync(oc, { recursive: true });
	const residue = describeAxisAbsence(oc);
	ok("a directory with no table is still absent", residue !== null);
	ok("and the reason says so", residue?.reason.includes("no index") ?? false);

	fs.mkdirSync(path.join(oc, "session_chunks.lance"), { recursive: true });
	ok("a directory WITH a table is present", describeAxisAbsence(oc) === null);

	console.log("\n🔒 absent axis — a read-only store refuses to create");

	const virgin = path.join(tmp, "sessions.lance");
	ok("precondition: the sessions axis does not exist", !fs.existsSync(virgin));

	const store = new VectorStore(virgin, 4096, { readOnly: true });
	let threw: unknown = null;
	try {
		await store.init();
	} catch (err) {
		threw = err;
	}
	ok("init() on an absent axis throws AxisAbsentError", isAxisAbsentError(threw));
	ok("and it carries the absence payload", isAxisAbsentError(threw) && threw.absence.axis === "sessions");
	// The whole point: the filesystem is untouched after a read attempt.
	ok("and NOTHING was created", !fs.existsSync(virgin));

	let sync: unknown = null;
	try { assertAxisPresent(virgin); } catch (err) { sync = err; }
	ok("assertAxisPresent throws the same error for callers that own their store", isAxisAbsentError(sync));

	console.log("\n🔒 absent axis — a writer is untouched");

	// The gate is opt-in precisely so the indexers keep working. If this ever
	// fails, the fix has been widened into store.ts and the index paths are dead.
	const writable = path.join(tmp, "writer-probe.lance");
	const writer = new VectorStore(writable, 4096);
	await writer.init();
	ok("a default (write) store still creates its dataset", fs.existsSync(writable));
	await writer.close();
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
	if (prev === undefined) delete process.env.ANDENKEN_DATA;
	else process.env.ANDENKEN_DATA = prev;
}

console.log(`\n${"─".repeat(40)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} passed  ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
