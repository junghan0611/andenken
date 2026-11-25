/**
 * attest:query — record a HUMAN judgment that vectors of one generation may
 * QUERY a store of another (e.g. local Ollama BGE-M3 queries against the
 * OpenClaw harvest embedded by OpenRouter BGE-M3). Equal dimension is never
 * this evidence; the attestation names the store fingerprint, the query
 * profile fingerprint, the evidence refs and the person who attests.
 *
 *   tsx scripts/attest-query.ts --db <sessions|md|openclaw> --query-profile <id>
 *                               --evidence <ref> [--evidence <ref> ...] --by <name>
 *
 * Interactive: prints exactly what will be written and requires "yes" on a
 * TTY. API 0; writes only `<db>.lance/andenken-query-attestation.json`. Never
 * applies to writes.
 */

import * as path from "node:path";
import * as readline from "node:readline";
import { getProfile, profileFingerprint, readStoreStamp, writeAttestation } from "../embedding-profile.ts";
import { getDataDir } from "../store.ts";

function arg(name: string, all = false): string[] {
	const out: string[] = [];
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) if (argv[i] === name && i + 1 < argv.length) out.push(argv[++i]);
	return all ? out : out.slice(0, 1);
}

const db = arg("--db")[0];
const qid = arg("--query-profile")[0];
const evidence = arg("--evidence", true);
const by = arg("--by")[0];
const fail = (msg: string, rc = 2): never => {
	console.error(`❌ ${msg}`);
	process.exit(rc);
};

if (!["sessions", "md", "openclaw"].includes(db ?? "")) fail("--db must be sessions, md or openclaw");
const query = qid ? getProfile(qid) : null;
if (!query) fail(`--query-profile must name a known profile`);
if (evidence.length === 0) fail("at least one --evidence <ref> is required (parity receipt, acceptance receipt)");
if (!by) fail("--by <name> is required");

const dbPath = path.join(getDataDir(), `${db}.lance`);
const st = readStoreStamp(dbPath);
if (st.state !== "ok") fail(`${dbPath}: ${st.state === "absent" ? "no generation stamp" : "unreadable generation stamp"}`);
const stamp = (st as { stamp: { profileId: string; fingerprint: string; dimensions: number } }).stamp;

console.log(`store     ${dbPath}`);
console.log(`          generation ${stamp.profileId} (${stamp.fingerprint.slice(0, 12)}…, ${stamp.dimensions}d)`);
console.log(`query     ${query!.id} (${profileFingerprint(query!).slice(0, 12)}…, ${query!.dimensions}d)`);
for (const e of evidence) console.log(`evidence  ${e}`);
console.log(`by        ${by}`);
console.log(`This lets ${query!.id} vectors QUERY this store. It never permits writes.`);

if (!process.stdin.isTTY) fail("refused: not an interactive terminal (a human attests)");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Type "yes" to record this attestation: ', (answer) => {
	rl.close();
	if (answer.trim() !== "yes") fail("not recorded", 1);
	try {
		const rec = writeAttestation(dbPath, query!, evidence, by!);
		console.log(`✅ recorded ${rec.queryProfileId} → ${rec.storeFingerprint.slice(0, 12)}… at ${rec.attestedAt}`);
	} catch (e) {
		fail(`refused: ${(e as { code?: string }).code ?? (e as Error).message}`, 1);
	}
});
