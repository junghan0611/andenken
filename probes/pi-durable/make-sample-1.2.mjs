// Synthetic pi-durable session DB against the PUBLISHED SDK 1.2.0 (the set entwurf's
// pi-durable carrier runs on, overlay/upstream-pin.json `sdk`). API 0: faux provider only,
// no network, no credentials. Writes ONLY under <out-dir>.
//
//   node probes/pi-durable/make-sample-1.2.mjs <out-dir>
//
// SDK root: PI_DURABLE_SDK_NODE_MODULES (default ~/repos/gh/entwurf/node_modules).
// The carrier's own `subagent.js` is imported so the child-conversation shape is the
// shipped one, not a re-implementation.
//
// Every input path the coordinator root actually receives today is exercised, plus the
// SDK paths that can write a user-role entry without a GLG keystroke:
//   entwurf-first-input:*   bootstrap.mjs launcher brief
//   (no requestId)          TUI controller.submit
//   entwurf-doorbell:*      meta-bridge-pi-durable doorbell
//   subagent:*              carrier subagent.js, in a task-owned child conversation
//   bash-background-report:* agent-config pi-durable/background-bash.mjs report
//   onYield continuation    generation.js answer(): pi.user with NO submission
//   input entry kind        1.2.0 InputEntry: custom kind carrying a user message
//   display-only write      1.2.0: kind+data only, settled at once
//   steer while busy        queued input placed at the next boundary
//   reset(handoff)          write submission with NULL requestId
//   tool control handoff    generation appends pi.reset with no submission
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const NM = process.env.PI_DURABLE_SDK_NODE_MODULES ?? `${process.env.HOME}/repos/gh/entwurf/node_modules`;
const CARRIER = process.env.PI_DURABLE_CARRIER ?? `${process.env.HOME}/repos/gh/entwurf/pi/pi-durable/carrier`;

const ai = await import(`${NM}/@earendil-works/pi-ai/dist/index.js`);
const { createModels } = await import(`${NM}/@earendil-works/pi-ai/dist/models.js`);
const durable = await import(`${NM}/@earendil-works/pi-durable/dist/index.js`);
const { openNodeSqliteStorage } = await import(`${NM}/@earendil-works/pi-durable/dist/storage/sqlite/node.js`);
const { BACKGROUND_CONTEXT: context } = await import(`${NM}/@earendil-works/chord/dist/context/index.js`);
const { Subagent } = await import(`${CARRIER}/subagent.js`);

const out = process.argv[2];
if (!out) throw new Error("usage: make-sample-1.2.mjs <out-dir>");

// Fixed identity and clock so the fixture's paths and timestamps are reproducible.
const cwd = "/home/junghan/repos/gh/andenken";
const bucket = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
const sessionName = "1792000000000-0b8f6d2e-4c1a-4e7b-9a3d-5f0e1c2b3a49";
const sessionDir = join(out, bucket, sessionName);
const workDir = join(out, ".work");
await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
await mkdir(sessionDir, { recursive: true });
const livePath = join(workDir, "session.sqlite");
const dbPath = join(sessionDir, "session.sqlite");
await rm(dbPath, { force: true });

let clock = Date.UTC(2026, 9, 15, 2, 0, 0);
const now = () => (clock += 1000);

const faux = ai.fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = durable.createRegistry();
registry.install(Subagent);

const GARDEN = "20261015T114746-1ee521";
let continueOnce = false;
registry.install(
	durable.defineExtension({
		name: "probe-tools",
		tools: [
			durable.defineTool({
				name: "entwurf_inbox_read",
				description: "read sibling mailbox",
				parameters: ai.Type.Object({ gardenId: ai.Type.String() }),
				replay: "unsafe",
				execute: async () => ({
					output: [{ type: "text", text: "SIBLING-BODY: implementer reports focused proofs 42/42 green; asks the coordinator to route review." }],
				}),
			}),
			durable.defineTool({
				name: "read",
				description: "read a file",
				parameters: ai.Type.Object({ path: ai.Type.String() }),
				replay: "safe",
				execute: async () => ({ output: [{ type: "text", text: "TOOL-OUTPUT: file contents line 1\nline 2" }] }),
			}),
			durable.defineTool({
				name: "handoff_probe",
				description: "end the context with a handoff",
				parameters: ai.Type.Object({ note: ai.Type.String() }),
				replay: "safe",
				execute: async (args) => ({
					output: [{ type: "text", text: "handing off" }],
					control: { handoff: args.note },
				}),
			}),
		],
		hooks: [
			durable.hook(durable.GenerationTask, {
				onYield: () => {
					if (!continueOnce) return undefined;
					continueOnce = false;
					return { continue: "HOOK-CONTINUE: keep going and finish the checklist." };
				},
			}),
		],
	}),
);

const settings = {};
const harness = await durable.Harness.open(
	await openNodeSqliteStorage(livePath),
	{ models, registry, settings, now, onReport: (e) => console.error("report", e) },
	context,
);
const root = await harness.root(context, { agent: { cwd, model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();

const A = ai.fauxAssistantMessage;
const call = ai.fauxToolCall;
const long = (s) => `${s} — ${"이 응답은 andenken 합성 표본용 assistant 본문이며 100자 하한을 넘기기 위해 충분히 길게 쓴다. ".repeat(2)}`;
const turn = async (conv, content, extra = {}) => (await conv.submit({ type: "input", content, ...extra }, context)).wait(context);

// 1. Launcher brief (bootstrap.mjs:372-376).
faux.setResponses([A(long("ASSISTANT-0 기동 브리프를 받고 콜백"))]);
await turn(root, "You are a fresh visible citizen that entwurf opened in the operator's tmux session. TASK-BRIEF: measure the durable source.", {
	requestId: `entwurf-first-input:${GARDEN}`,
});

// 2. GLG at the TUI (runtime.ts:332, no requestId).
faux.setResponses([A(long("ASSISTANT-1 GLG에게 답한다"))]);
await turn(root, "GLG-1: durable 대화를 임베딩에 넣자. 귀한 대화야, 내 턴도 많이 들어있고.");

// 3. GLG → tool → final.
faux.setResponses([A([call("read", { path: "AGENTS.md" })], { stopReason: "toolUse" }), A(long("ASSISTANT-2 파일을 읽고 GLG에게 보고"))]);
await turn(root, "GLG-2: AGENTS.md를 읽고 세션 source 문장이 어디 있는지 알려줘.");

// 4. Doorbell (meta-bridge-pi-durable.ts:937-944) → inbox read → reaction.
faux.setResponses([
	A([call("entwurf_inbox_read", { gardenId: GARDEN })], { stopReason: "toolUse" }),
	A(long("ASSISTANT-3 형제 보고를 읽고 라우팅 판단")),
]);
await turn(root, `[entwurf inbox] 1 unread mailbox message available for garden ${GARDEN}.`, {
	whenBusy: "followUp",
	requestId: `entwurf-doorbell:${GARDEN}:2026-10-15T02-48-03-839Z-2ae31c.msg`,
});

// 5. GLG → subagent (child conversation owned by the tool task) → final.
faux.setResponses([
	A([call("subagent", { task: "SUBAGENT-TASK: summarize the durable schema tables in five lines." })], { stopReason: "toolUse" }),
	A(long("SUBAGENT-ANSWER 스키마 요약을 코디네이터에게 돌려준다")),
	A(long("ASSISTANT-4 서브에이전트 결과를 GLG에게 전달")),
]);
await turn(root, "GLG-4: 서브에이전트에게 스키마 요약을 시키고 결과를 나에게 알려줘.");

// 6. Background report (agent-config background-bash.mjs:362-367).
faux.setResponses([A(long("ASSISTANT-5 백그라운드 결과를 읽었다"))]);
await turn(root, "[bash_background] task 7 finished: exit 0. Log at /tmp/bg-7.log", {
	whenBusy: "followUp",
	requestId: "bash-background-report:7",
});

// 7. onYield continuation: the hook writes pi.user with no submission row.
continueOnce = true;
faux.setResponses([A(long("ASSISTANT-6a 첫 답")), A(long("ASSISTANT-6b 훅이 이어 쓰게 한 답"))]);
await turn(root, "GLG-6: 체크리스트를 끝까지 진행해.");

// 8. 1.2.0 input entry: custom kind carrying a user message.
faux.setResponses([A(long("ASSISTANT-7 커스텀 입력 kind에 답"))]);
await turn(root, "CUSTOM-INPUT: a host-defined input kind, not pi.user.", { entry: { kind: "probe.input", data: { via: "probe" } } });

// 9. 1.2.0 display-only write.
await (await root.submit({ type: "write", entry: { kind: "probe.display", data: { text: "DISPLAY-ONLY: shown, never sent to the model." } } }, context)).wait(context);

// 10. Steer while busy: GLG types during a run; the input queues and is placed at the boundary.
let release;
const gate = new Promise((r) => (release = r));
let reachedGate;
const reached = new Promise((r) => (reachedGate = r));
faux.setResponses([
	async () => {
		reachedGate();
		await gate;
		return A(long("ASSISTANT-8 긴 작업의 답"));
	},
	A(long("ASSISTANT-9 steer 입력에 답")),
]);
const busyRun = await root.submit({ type: "input", content: "GLG-8: 긴 작업을 시작해." }, context);
await reached;
const steered = await root.submit({ type: "input", content: "GLG-9: 잠깐, 방향을 바꿔서 출처 식별부터 해.", whenBusy: "steer" }, context);
release();
await busyRun.wait(context);
await steered.wait(context);
await root.waitForIdle(context);

// 11. Manual compaction (write submission `compaction:<taskId>`).
faux.setResponses([A("COMPACTION-SUMMARY: GLG wants durable turns embedded and readable by siblings.")]);
settings.compaction = { enabled: false, reserveTokens: 1000, keepRecentTokens: 30, backgroundTokens: 0 };
const compactTask = await root.compact(undefined, context);
await harness.waitForTask(compactTask, context);
await root.waitForIdle(context);

// 12. GLG after compaction.
faux.setResponses([A(long("ASSISTANT-10 compaction 이후 답"))]);
const after = await turn(root, "GLG-10: compaction 뒤에도 내 원문이 저장면에 남는지 확인하자.");

// 13. Fork at that answer; GLG continues in the fork.
const fork = await root.fork(after.answer, { ownership: { kind: "ownerless" } }, context);
faux.setResponses([A(long("ASSISTANT-11F 포크에서의 답"))]);
await turn(fork, "GLG-11F: 포크에서 다른 방향을 시험해 본다.");

// 14. reset(handoff): write submission, NULL requestId.
await root.reset("HANDOFF-RESET: continue from the durable source contract; previous context cleared.", context);
await root.waitForIdle(context);
faux.setResponses([A(long("ASSISTANT-12 reset 이후 답"))]);
await turn(root, "GLG-12: reset 이후 첫 발화다. handoff는 내 말이 아니다.");

// 15. Tool-control handoff: generation appends pi.reset itself.
faux.setResponses([A([call("handoff_probe", { note: "HANDOFF-TOOL: picked up by the next context." })], { stopReason: "toolUse" })]);
await turn(root, "GLG-13: 이번 컨텍스트를 handoff로 넘겨.");
await root.waitForIdle(context);

// 16. Provider error with partial text, then the retried final.
settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
faux.setResponses([A("PARTIAL-ERR: 부분 응답이 끊겼다", { stopReason: "error", errorMessage: "overloaded" }), A(long("ASSISTANT-14 재시도 후 최종 답"))]);
await turn(root, "GLG-14: provider 오류 후 재시도된 최종 응답만 남는지 본다.");

// 17. Aborted generation.
let reachAbort;
const abortReached = new Promise((r) => (reachAbort = r));
faux.setResponses([
	(_c, options) =>
		new Promise((_, reject) => {
			reachAbort();
			options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
		}),
]);
await root.submit({ type: "input", content: "GLG-15: 이 요청은 중간에 abort된다." }, context);
await abortReached;
await root.abort(context);
await root.waitForIdle(context);

await harness.close(context);

// Closed snapshot, the shape the source contract reads: one file, rollback journal.
const src = new DatabaseSync(livePath, { readOnly: true });
src.exec(`VACUUM INTO '${dbPath.replaceAll("'", "''")}'`);
src.close();
await rm(workDir, { recursive: true, force: true });
console.log(JSON.stringify({ dbPath, bucket, sessionName, cwd }));
