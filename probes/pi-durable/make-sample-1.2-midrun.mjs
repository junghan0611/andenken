// Two closed snapshots of ONE synthetic pi-durable session, taken at different times, against
// the published SDK 1.2.0 (same SDK root as make-sample-1.2.mjs). API 0: faux provider only.
// Writes ONLY under <out-dir>:
//
//   node probes/pi-durable/make-sample-1.2-midrun.mjs <out-dir>
//     <out-dir>/snap1/<bucket>/<session>/session.sqlite   mid-run: a human input placed, not yet answered
//     <out-dir>/snap2/<bucket>/<session>/session.sqlite   after that run, plus an interleaved run
//
// Turn 1: a short human decision ("응 진행해"), an assistant turn with text + a tool call, then a
// final answer held behind a gate; snap1 is taken while the gate holds.
// Turn 2: a human input whose tool call is held; while it runs a doorbell input arrives with
// whenBusy "steer" and is placed at the tool boundary, so one run answers both inputs.
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const NM = process.env.PI_DURABLE_SDK_NODE_MODULES ?? `${process.env.HOME}/repos/gh/entwurf/node_modules`;
const ai = await import(`${NM}/@earendil-works/pi-ai/dist/index.js`);
const { createModels } = await import(`${NM}/@earendil-works/pi-ai/dist/models.js`);
const durable = await import(`${NM}/@earendil-works/pi-durable/dist/index.js`);
const { openNodeSqliteStorage } = await import(`${NM}/@earendil-works/pi-durable/dist/storage/sqlite/node.js`);
const { BACKGROUND_CONTEXT: context } = await import(`${NM}/@earendil-works/chord/dist/context/index.js`);

const out = process.argv[2];
if (!out) throw new Error("usage: make-sample-1.2-midrun.mjs <out-dir>");

const cwd = "/home/junghan/repos/gh/andenken";
const bucket = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
const sessionName = "1792000000001-6c2a9e41-8d3b-4f5a-b7c1-2e9d0f4a8b13";
const workDir = join(out, ".work");
await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
const livePath = join(workDir, "session.sqlite");

// Closed snapshot of the live (WAL) synthetic DB: one read transaction, rollback journal.
async function snapshot(name) {
	const dir = join(out, name, bucket, sessionName);
	await mkdir(dir, { recursive: true });
	const file = join(dir, "session.sqlite");
	await rm(file, { force: true });
	const db = new DatabaseSync(livePath, { readOnly: true });
	db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
	db.close();
	return file;
}

let clock = Date.UTC(2026, 9, 15, 3, 0, 0);
const now = () => (clock += 1000);

const faux = ai.fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = durable.createRegistry();
let releaseTool;
let toolHeld;
registry.install(
	durable.defineExtension({
		name: "probe-tools",
		tools: [
			durable.defineTool({
				name: "read",
				description: "read a file",
				parameters: ai.Type.Object({ path: ai.Type.String() }),
				replay: "safe",
				execute: async () => ({ output: [{ type: "text", text: "TOOL-OUTPUT: file contents" }] }),
			}),
			durable.defineTool({
				name: "slow_read",
				description: "read a file slowly",
				parameters: ai.Type.Object({ path: ai.Type.String() }),
				replay: "safe",
				execute: async () => {
					toolHeld();
					await new Promise((r) => (releaseTool = r));
					return { output: [{ type: "text", text: "TOOL-OUTPUT: slow file contents" }] };
				},
			}),
		],
	}),
);

const harness = await durable.Harness.open(
	await openNodeSqliteStorage(livePath),
	{ models, registry, settings: {}, now, onReport: (e) => console.error("report", e) },
	context,
);
const root = await harness.root(context, { agent: { cwd, model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();
const A = ai.fauxAssistantMessage;
const long = (s) => `${s} — ${"이 응답은 andenken 합성 표본용 assistant 본문이며 100자 하한을 넘기기 위해 충분히 길게 쓴다. ".repeat(2)}`;

// Turn 1 — snap1 is taken while the final answer is held.
let releaseFinal;
let finalHeld;
const atFinal = new Promise((r) => (finalHeld = r));
faux.setResponses([
	A([ai.fauxText("INTERMEDIATE-EXPLAIN: AGENTS.md를 먼저 읽고 판단하겠습니다."), ai.fauxToolCall("read", { path: "AGENTS.md" })], { stopReason: "toolUse" }),
	async () => {
		finalHeld();
		await new Promise((r) => (releaseFinal = r));
		return A(long("FINAL-ANSWER-1 읽은 결과로 GLG에게 답한다"));
	},
]);
const turn1 = await root.submit({ type: "input", content: "응 진행해" }, context);
await atFinal;
const snap1 = await snapshot("snap1");
releaseFinal();
await turn1.wait(context);
await root.waitForIdle(context);

// Turn 2 — a doorbell steers into a running human run.
const atTool = new Promise((r) => (toolHeld = r));
faux.setResponses([
	A([ai.fauxText("MIXED-EXPLAIN: 천천히 읽는 동안 다른 입력이 끼어들 수 있다."), ai.fauxToolCall("slow_read", { path: "NEXT.md" })], { stopReason: "toolUse" }),
	A(long("FINAL-ANSWER-2 사람 입력과 끼어든 doorbell에 함께 답한다")),
]);
const turn2 = await root.submit({ type: "input", content: "GLG-M2: NEXT.md를 천천히 읽어 줘." }, context);
await atTool;
const bell = await root.submit(
	{
		type: "input",
		content: "[entwurf inbox] 1 unread mailbox message available for garden 20261015T114746-1ee521.",
		whenBusy: "steer",
		requestId: "entwurf-doorbell:20261015T114746-1ee521:2026-10-15T03-30-00-000Z-midrun.msg",
	},
	context,
);
releaseTool();
await turn2.wait(context);
await bell.wait(context);
await root.waitForIdle(context);

await harness.close(context);
const snap2 = await snapshot("snap2");
await rm(workDir, { recursive: true, force: true });
console.log(JSON.stringify({ snap1, snap2, bucket, sessionName, cwd }));
