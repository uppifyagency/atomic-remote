import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakePi, makeBridgeCtx, readOutbox, untilOutbox, sleep } from "./helpers.mjs";

// The bridge reads ATOMIC_CODING_AGENT_DIR once at module load; set it first.
process.env.ATOMIC_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-bridge-test-"));
const bridgeRoot = path.join(process.env.ATOMIC_CODING_AGENT_DIR, "remote-bridge");
const { default: registerBridge } = await import("../atomic-extension/atomic-remote-bridge.ts");

let bootSeq = 0;

async function boot(t, { piOptions = {}, ctxOptions = {}, preStart } = {}) {
	const sessionId = `br-${String(bootSeq++).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
	const world = makeFakePi(piOptions);
	registerBridge(world.pi);
	const ctx = makeBridgeCtx({ sessionId, ...ctxOptions });
	const dir = path.join(bridgeRoot, sessionId);
	if (preStart) {
		fs.mkdirSync(path.join(dir, "inbox", ".tmp"), { recursive: true });
		preStart(dir);
	}
	await world.fire("session_start", { reason: "startup" }, ctx);
	t.after(() => world.fire("session_shutdown", { reason: "quit" }));
	const inboxDir = path.join(dir, "inbox");
	let dropSeq = 0;
	return {
		world,
		ctx,
		dir,
		sessionId,
		inboxDir,
		drop(payload, { name } = {}) {
			const file = name ?? `${String(Date.now()).padStart(14, "0")}-${String(dropSeq++).padStart(3, "0")}-drop.json`;
			const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
			fs.writeFileSync(path.join(inboxDir, ".tmp", file), raw);
			fs.renameSync(path.join(inboxDir, ".tmp", file), path.join(inboxDir, file));
		},
		records: () => readOutbox(dir),
		until: (predicate, options) => untilOutbox(dir, predicate, options),
	};
}

test("session_start: registers the session dir, meta, heartbeat, bridge_ready", async (t) => {
	const b = await boot(t);
	const meta = JSON.parse(fs.readFileSync(path.join(b.dir, "meta.json"), "utf8"));
	assert.equal(meta.status, "live");
	assert.equal(meta.protocol, 2);
	assert.equal(meta.sessionId, b.sessionId);
	const heartbeat = JSON.parse(fs.readFileSync(path.join(b.dir, "heartbeat.json"), "utf8"));
	assert.ok(Date.now() - heartbeat.ts < 5000);
	assert.equal(heartbeat.busy, false);
	const ready = b.records().find((r) => r.type === "bridge_ready");
	assert.equal(ready.protocol, 2);
	assert.ok(b.world.registered.has("remote-name"));
});

test("prompt command: delivered via sendUserMessage, acked, inbox file consumed", async (t) => {
	const b = await boot(t);
	b.drop({ id: "cmd-prompt-1", action: "prompt", message: "run tests" });
	const accepted = await b.until((r) => r.type === "accepted" && r.id === "cmd-prompt-1");
	assert.equal(accepted.delivered, "immediate");
	assert.deepEqual(b.world.sent[0].message, "run tests");
	await sleep(100);
	assert.equal(fs.readdirSync(b.inboxDir).filter((n) => n.endsWith(".json")).length, 0);
});

test("prompt falls back to steer delivery when immediate injection throws", async (t) => {
	let calls = 0;
	const b = await boot(t, {
		piOptions: {
			sendUserMessage: (_message, options) => {
				calls++;
				if (!options?.deliverAs) throw new Error("busy");
			},
		},
	});
	b.drop({ id: "cmd-fb-1", action: "prompt", message: "urgent" });
	const accepted = await b.until((r) => r.type === "accepted" && r.id === "cmd-fb-1");
	assert.equal(accepted.delivered, "steer-fallback");
	assert.equal(calls, 2);
});

test("interrupt command: goes through sendMessage with triggerTurn", async (t) => {
	const b = await boot(t);
	b.drop({ id: "cmd-int-1", action: "interrupt", message: "stop, do this instead" });
	await b.until((r) => r.type === "accepted" && r.id === "cmd-int-1");
	const sent = b.world.sent[0];
	assert.equal(sent.kind, "custom");
	assert.equal(sent.message.customType, "atomic-remote");
	assert.equal(sent.options.deliverAs, "interrupt");
	assert.equal(sent.options.triggerTurn, true);
});

test("ping and status answer without touching the agent", async (t) => {
	const b = await boot(t);
	b.drop({ id: "cmd-ping-1", action: "ping" });
	const pong = await b.until((r) => r.type === "pong" && r.id === "cmd-ping-1");
	assert.equal(pong.protocol, 2);
	b.drop({ id: "cmd-st-1", action: "status" });
	const report = await b.until((r) => r.type === "status_report" && r.id === "cmd-st-1");
	assert.equal(report.busy, false);
	assert.deepEqual(report.pendingWorkflows, []);
	assert.equal(b.world.sent.length, 0);
});

test("abort command: calls ctx.abort and acks", async (t) => {
	let aborted = false;
	const b = await boot(t);
	b.ctx.abort = () => {
		aborted = true;
	};
	b.drop({ id: "cmd-ab-1", action: "abort" });
	await b.until((r) => r.type === "accepted" && r.id === "cmd-ab-1");
	assert.equal(aborted, true);
});

test("validation: every malformed command still gets an error ack", async (t) => {
	const b = await boot(t);
	const cases = [
		{ payload: "not json {", match: /invalid JSON/, id: null },
		{ payload: { action: "prompt", message: "x" }, match: /missing or invalid id/, id: null },
		{ payload: { id: "bad action", action: "prompt", message: "x" }, match: /missing or invalid id/, id: null },
		{ payload: { id: "v-1", action: "reboot" }, match: /unknown action/, id: "v-1" },
		{ payload: { id: "v-2", action: "prompt", message: 42 }, match: /requires a string message/, id: "v-2" },
		{ payload: { id: "v-3", action: "prompt", message: "   " }, match: /message is empty/, id: "v-3" },
		{ payload: { id: "v-4", action: "prompt", message: "bad\u0007bell" }, match: /control characters/, id: "v-4" },
		{ payload: { id: "v-5", action: "prompt", message: "x".repeat(33_000) }, match: /exceeds 32000/, id: "v-5" },
	];
	for (const item of cases) {
		b.drop(item.payload);
		const error = await b.until((r) => r.type === "error" && String(r.error).match(item.match));
		assert.equal(error.id, item.id, `id for ${item.match}`);
	}
	assert.equal(b.world.sent.length, 0, "no malformed command may reach the agent");
});

test("validation: unknown keys are reported on rejected commands", async (t) => {
	const b = await boot(t);
	b.drop({ id: "v-6", action: "prompt", message: "", attachment: "x", extra: 1 });
	const error = await b.until((r) => r.type === "error" && r.id === "v-6");
	assert.deepEqual(error.unknownKeys, ["attachment", "extra"]);
});

test("validation: newlines and tabs in messages are legal", async (t) => {
	const b = await boot(t);
	b.drop({ id: "v-7", action: "prompt", message: "line1\n\tline2\r\nline3" });
	await b.until((r) => r.type === "accepted" && r.id === "v-7");
});

test("ingestion: an oversized command file is rejected, not read", async (t) => {
	const b = await boot(t);
	b.drop(`{"id":"big","action":"prompt","message":"${"y".repeat(70_000)}"}`);
	const error = await b.until((r) => r.type === "error");
	assert.match(error.error, /exceeds 65536 bytes/);
});

test("ingestion: commands queued before startup run serially in filename order", async (t) => {
	const b = await boot(t, {
		preStart(dir) {
			for (const [index, id] of ["first", "second", "third"].entries()) {
				fs.writeFileSync(
					path.join(dir, "inbox", `00000000000001-${String(index).padStart(3, "0")}-${id}.json`),
					JSON.stringify({ id, action: "prompt", message: `msg-${id}` }),
				);
			}
		},
	});
	await b.until((r) => r.type === "accepted" && r.id === "third");
	assert.deepEqual(
		b.world.sent.map((s) => s.message),
		["msg-first", "msg-second", "msg-third"],
	);
});

test("ingestion: leftover .processing files surface as recoverable errors with their id", async (t) => {
	const b = await boot(t, {
		preStart(dir) {
			fs.writeFileSync(
				path.join(dir, "inbox", "00000000000001-000-lostcmd.json.processing"),
				JSON.stringify({ id: "lostcmd", action: "prompt", message: "gone" }),
			);
		},
	});
	const error = await b.until((r) => r.type === "error" && r.recoverable === true);
	assert.equal(error.id, "lostcmd");
	assert.match(error.error, /interrupted by engine restart/);
	assert.equal(fs.readdirSync(b.inboxDir).filter((n) => n.endsWith(".processing")).length, 0);
});

test("attribution: extension input binds the turn; records carry the owner; settle resets", async (t) => {
	const b = await boot(t);
	b.drop({ id: "own-1", action: "prompt", message: "attributed work" });
	await b.until((r) => r.type === "accepted" && r.id === "own-1");
	await b.world.fire("input", { source: "extension", text: "attributed work" });
	await b.until((r) => r.type === "turn_bound" && r.id === "own-1");
	await b.world.fire("agent_start", {}, b.ctx);
	await b.world.fire("agent_end", {
		messages: [{ role: "assistant", content: [{ type: "text", text: "the reply" }] }],
	});
	await b.world.fire("agent_settled", {}, b.ctx);
	const settle = b.records().find((r) => r.type === "agent_settled");
	assert.equal(settle.owner, "own-1");
	assert.equal(settle.text, "the reply");
	assert.equal(settle.foreignInputSeen, false);

	await b.world.fire("agent_start", {}, b.ctx);
	const starts = b.records().filter((r) => r.type === "agent_start");
	assert.equal(starts.at(-1).owner, null, "ownership must not leak into the next turn");
});

test("attribution: interactive input is flagged and contaminates the settle", async (t) => {
	const b = await boot(t);
	b.drop({ id: "own-2", action: "prompt", message: "contested work" });
	await b.until((r) => r.type === "accepted" && r.id === "own-2");
	await b.world.fire("input", { source: "extension", text: "contested work" });
	await b.world.fire("agent_start", {}, b.ctx);
	await b.world.fire("input", { source: "interactive", text: "user butting in" });
	await b.world.fire("agent_settled", {}, b.ctx);
	const foreign = b.records().find((r) => r.type === "foreign_input");
	assert.match(foreign.preview, /user butting in/);
	const settle = b.records().find((r) => r.type === "agent_settled");
	assert.equal(settle.owner, "own-2");
	assert.equal(settle.foreignInputSeen, true);
});

test("attribution: interrupt binds via the next agent_start", async (t) => {
	const b = await boot(t);
	b.drop({ id: "int-2", action: "interrupt", message: "change course" });
	await b.until((r) => r.type === "accepted" && r.id === "int-2");
	await b.world.fire("agent_start", {}, b.ctx);
	const bound = b.records().find((r) => r.type === "turn_bound" && r.via === "interrupt");
	assert.equal(bound.id, "int-2");
});

test("attribution: interrupt on a busy session preempts the bound owner and claims the new turn", async (t) => {
	const b = await boot(t);
	b.drop({ id: "old-cmd", action: "prompt", message: "long job" });
	await b.until((r) => r.type === "accepted" && r.id === "old-cmd");
	await b.world.fire("input", { source: "extension", text: "long job" });
	await b.world.fire("agent_start", {}, b.ctx);

	b.drop({ id: "int-cmd", action: "interrupt", message: "drop everything, do X" });
	await b.until((r) => r.type === "accepted" && r.id === "int-cmd");

	// Live-observed ordering (atomic 0.9.13): the aborted turn ends, the
	// interrupt's turn starts, THEN the aborted run settles, then the
	// interrupt's turn ends and settles.
	await b.world.fire("agent_end", { messages: [] });
	await b.world.fire("agent_start", {}, b.ctx);
	await b.world.fire("agent_settled", {}, b.ctx);
	await b.world.fire("agent_end", {
		messages: [{ role: "assistant", content: [{ type: "text", text: "INTERRUPT-VISTO-OK" }] }],
	});
	await b.world.fire("agent_settled", {}, b.ctx);

	const bound = b.records().find((r) => r.type === "turn_bound" && r.id === "int-cmd");
	assert.equal(bound?.via, "interrupt", "the interrupt must claim its turn even over a bound owner");
	const settles = b.records().filter((r) => r.type === "agent_settled");
	assert.equal(settles.length, 2);
	assert.equal(settles[0].owner, "old-cmd");
	assert.equal(settles[0].aborted, true, "the preempted command's settle must say it was aborted");
	assert.equal(settles[1].owner, "int-cmd", "the reply must be attributed to the interrupt command");
	assert.equal(settles[1].text, "INTERRUPT-VISTO-OK");
});

test("workflows: launch detected, settle goes provisional, lifecycle mirrored from entries", async (t) => {
	const b = await boot(t);
	const runId = "12345678-abcd-4ef0-9876-1234567890ab";
	b.drop({ id: "wf-1", action: "prompt", message: "start the workflow" });
	await b.until((r) => r.type === "accepted" && r.id === "wf-1");
	await b.world.fire("input", { source: "extension", text: "start the workflow" });
	await b.world.fire("agent_start", {}, b.ctx);
	await b.world.fire("tool_execution_end", {
		toolName: "workflow",
		isError: false,
		result: { content: `Workflow run started: ${runId}` },
	});
	const started = await b.until((r) => r.type === "workflow_started");
	assert.equal(started.runId, runId);
	assert.equal(started.owner, "wf-1");

	await b.world.fire("agent_settled", {}, b.ctx);
	const settle = b.records().find((r) => r.type === "agent_settled");
	assert.equal(settle.provisional, true);
	assert.deepEqual(settle.pendingWork, [{ kind: "workflow", runId }]);

	b.ctx.entries.push({ type: "custom", text: `workflow ${runId} completed: all stages green` });
	await b.world.fire("agent_start", {}, b.ctx);
	const lifecycle = b.records().find((r) => r.type === "workflow_lifecycle");
	assert.equal(lifecycle.runId, runId);
	assert.equal(lifecycle.kind, "completed");
	assert.equal(lifecycle.terminal, true);

	b.drop({ id: "wf-st", action: "status" });
	const report = await b.until((r) => r.type === "status_report" && r.id === "wf-st");
	assert.deepEqual(report.pendingWorkflows, [], "terminal run must leave pendingWorkflows");
});

test("shutdown: marks meta closed, clears only the inbox, keeps the outbox", async (t) => {
	const b = await boot(t);
	b.drop({ id: "sd-1", action: "prompt", message: "before shutdown" });
	await b.until((r) => r.type === "accepted" && r.id === "sd-1");
	await b.world.fire("session_shutdown", { reason: "quit" });
	const meta = JSON.parse(fs.readFileSync(path.join(b.dir, "meta.json"), "utf8"));
	assert.equal(meta.status, "closed");
	assert.ok(meta.closedAt, "closedAt must be recorded for prune aging");
	assert.ok(!fs.existsSync(b.inboxDir), "pending commands must not survive a dead session");
	const closed = b.records().find((r) => r.type === "bridge_closed");
	assert.equal(closed.reason, "quit");
	assert.ok(fs.existsSync(path.join(b.dir, "outbox.jsonl")), "history must survive shutdown");
});

test("session switch: no attribution or workflow state leaks into the next session", async (t) => {
	const b = await boot(t);
	b.drop({ id: "leak-1", action: "prompt", message: "unclaimed binding" });
	await b.until((r) => r.type === "accepted" && r.id === "leak-1");

	const nextId = `br-next-${Math.random().toString(36).slice(2, 8)}`;
	const nextCtx = makeBridgeCtx({ sessionId: nextId });
	await b.world.fire("session_start", { reason: "new" }, nextCtx);
	t.after(() => b.world.fire("session_shutdown", { reason: "quit" }));

	await b.world.fire("input", { source: "extension", text: "unclaimed binding" });
	const nextDir = path.join(bridgeRoot, nextId);
	assert.equal(
		readOutbox(nextDir).filter((r) => r.type === "turn_bound").length,
		0,
		"a binding from the previous session must not claim a turn in the new one",
	);
});

test("/remote-name: updates meta.name; empty resets to cwd basename", async (t) => {
	const b = await boot(t);
	const handler = b.world.registered.get("remote-name").handler;
	await handler("worker-7", { ui: { notify() {} } });
	assert.equal(JSON.parse(fs.readFileSync(path.join(b.dir, "meta.json"), "utf8")).name, "worker-7");
	await handler("", { ui: { notify() {} } });
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(b.dir, "meta.json"), "utf8")).name,
		path.basename(process.cwd()),
	);
});
