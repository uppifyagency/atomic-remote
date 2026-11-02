import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakePi, makeBridgeCtx, readOutbox, untilOutbox, sleep, makeAgentDir, makeSession, runCtl } from "./helpers.mjs";

// Behaviour observed live against Atomic 0.9.63 (2026-11-02). Each test replays
// the event ordering or file shape that engine produced.
process.env.ATOMIC_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-0963-test-"));
process.env.ATOMIC_REMOTE_INTERRUPT_SETTLE_GRACE_MS = "100";
const bridgeRoot = path.join(process.env.ATOMIC_CODING_AGENT_DIR, "remote-bridge");
const { default: registerBridge } = await import("../atomic-extension/atomic-remote-bridge.ts");

let bootSeq = 0;

async function boot(t, ctxExtra = {}) {
	const sessionId = `v963-${String(bootSeq++).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
	const world = makeFakePi();
	registerBridge(world.pi);
	let idle = true;
	const ctx = Object.assign(makeBridgeCtx({ sessionId, isIdle: () => idle }), ctxExtra);
	await world.fire("session_start", { reason: "startup" }, ctx);
	t.after(() => world.fire("session_shutdown", { reason: "quit" }));
	const dir = path.join(bridgeRoot, sessionId);
	return {
		world,
		ctx,
		dir,
		setIdle: (value) => {
			idle = value;
		},
		drop(payload) {
			const file = `${String(Date.now()).padStart(14, "0")}-000-drop.json`;
			fs.writeFileSync(path.join(dir, "inbox", ".tmp", file), JSON.stringify(payload));
			fs.renameSync(path.join(dir, "inbox", ".tmp", file), path.join(dir, "inbox", file));
		},
		records: () => readOutbox(dir),
		until: (predicate) => untilOutbox(dir, predicate),
	};
}

test("0.9.63: an interrupt turn that the engine never settles is settled by the bridge once idle", async (t) => {
	const b = await boot(t);
	b.drop({ id: "old-cmd", action: "prompt", message: "long job" });
	await b.until((r) => r.type === "accepted" && r.id === "old-cmd");
	b.setIdle(false);
	await b.world.fire("input", { source: "extension", text: "long job" });
	await b.world.fire("agent_start", {}, b.ctx);
	b.drop({ id: "int-cmd", action: "interrupt", message: "stop" });
	await b.until((r) => r.type === "accepted" && r.id === "int-cmd");

	// Live 0.9.63 ordering: aborted end, interrupt start, aborted settle,
	// interrupt end, and then nothing (the raw agent.prompt path skips settle).
	await b.world.fire("agent_end", { messages: [] }, b.ctx);
	await b.world.fire("agent_start", {}, b.ctx);
	await b.world.fire("agent_settled", { aborted: true }, b.ctx);
	await b.world.fire(
		"agent_end",
		{ messages: [{ role: "assistant", content: [{ type: "text", text: "INTERRUPTED" }] }] },
		b.ctx,
	);
	await sleep(250);
	assert.equal(
		b.records().filter((r) => r.type === "agent_settled" && r.owner === "int-cmd").length,
		0,
		"no settle while the engine still reports busy",
	);
	b.setIdle(true);
	const settle = await b.until((r) => r.type === "agent_settled" && r.owner === "int-cmd");
	assert.equal(settle.text, "INTERRUPTED");
	assert.equal(settle.synthesized, "interrupt_turn");

	// The next unrelated turn (e.g. a workflow notice) must not inherit the
	// interrupt as owner: live, it captured "Workflow started." as the reply.
	await b.world.fire("agent_start", {}, b.ctx);
	const next = b.records().filter((r) => r.type === "agent_start").at(-1);
	assert.equal(next.owner, null);
});

test("0.9.63: a real settle for the interrupt turn wins over the fallback", async (t) => {
	const b = await boot(t);
	b.drop({ id: "int-only", action: "interrupt", message: "go" });
	await b.until((r) => r.type === "accepted" && r.id === "int-only");
	await b.world.fire("agent_start", {}, b.ctx);
	await b.world.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "OK" }] }] }, b.ctx);
	await b.world.fire("agent_settled", {}, b.ctx);
	await sleep(250);
	const settles = b.records().filter((r) => r.type === "agent_settled");
	assert.equal(settles.length, 1);
	assert.equal(settles[0].owner, "int-only");
	assert.equal(settles[0].synthesized, undefined);
});

test("0.9.63: workflow stage and subagent child sessions do not register as remote targets", async (t) => {
	for (const extra of [
		{ orchestrationContext: { kind: "workflow-stage", workflowRunId: "r", workflowStageId: "s", workflowStageName: "ask" } },
		{ subagentPolicy: {} },
	]) {
		const b = await boot(t, extra);
		assert.equal(fs.existsSync(b.dir), false, `child session registered: ${JSON.stringify(Object.keys(extra))}`);
	}
});

// --- controller: statusFile shape written by 0.9.63 ---------------------------

function writeStatusFile0963(projDir, runId) {
	const file = path.join(projDir, ".atomic", "workflows", "status.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const run = {
		id: runId,
		name: "ar-ask",
		status: "running",
		phase: "executing",
		stages: [
			{
				id: "f0dae963-a41b-494d-8236-4edfcc2bbfb4",
				name: "ask",
				status: "awaiting_input",
				awaitingInputSince: 1793621187902,
				inputRequest: {
					id: "readiness-gate-x",
					kind: "readiness_gate",
					questions: [
						{
							question: "Are you ready to move on to the next stage?",
							header: "Continue?",
							options: [
								{ label: "I'm ready to move on to the next workflow stage.", description: "Complete this stage." },
								{ label: "I have more to explore or ask about.", description: "Stay." },
							],
						},
					],
				},
			},
		],
	};
	fs.writeFileSync(file, JSON.stringify({ runs: [run], notices: [], version: 3 }, null, 2));
}

test("0.9.63: a running run whose stage awaits input is marked awaitingInput with its option labels", async () => {
	const agentDir = makeAgentDir();
	const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-proj-"));
	const runId = "0dcd4857-0dce-49c0-9310-acb25c060b20";
	writeStatusFile0963(projDir, runId);
	const session = makeSession(agentDir, { cwd: projDir });
	session.emit({ type: "accepted", id: "wf-cmd", action: "run_workflow", workflowName: "ar-ask", contended: false });
	session.emit({ type: "workflow_started", runId, owner: "wf-cmd" });
	const result = await runCtl(["outcome", session.id, "wf-cmd"], agentDir);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const outcome = JSON.parse(result.stdout);
	assert.equal(outcome.state, "detached");
	assert.equal(outcome.runs[0].awaitingInput, true);
	assert.equal(outcome.runs[0].question.text, "Are you ready to move on to the next stage?");
	assert.deepEqual(outcome.runs[0].question.options, [
		"I'm ready to move on to the next workflow stage.",
		"I have more to explore or ask about.",
	]);
});
