import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeAgentDir, makeSession, runCtl, makeFakePi, makeBridgeCtx, untilOutbox } from "./helpers.mjs";

// Protocol v3 contracts: structured plan handoff, queryable outcomes, and a
// single source of truth for busy/idle. Written red against the v2 baseline.

process.env.ATOMIC_CODING_AGENT_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-bridge-test-"));
const bridgeRoot = path.join(process.env.ATOMIC_CODING_AGENT_DIR, "remote-bridge");
const { default: registerBridge } = await import("../atomic-extension/atomic-remote-bridge.ts");

let bootSeq = 0;

async function boot(t, { piOptions = {}, ctxOptions = {} } = {}) {
	const sessionId = `p3-${String(bootSeq++).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
	const world = makeFakePi(piOptions);
	registerBridge(world.pi);
	const ctx = makeBridgeCtx({ sessionId, ...ctxOptions });
	await world.fire("session_start", { reason: "startup" }, ctx);
	t.after(() => world.fire("session_shutdown", { reason: "quit" }));
	const dir = path.join(bridgeRoot, sessionId);
	const inboxDir = path.join(dir, "inbox");
	let dropSeq = 0;
	return {
		world,
		ctx,
		dir,
		drop(payload) {
			const file = `${String(Date.now()).padStart(14, "0")}-${String(dropSeq++).padStart(3, "0")}-drop.json`;
			fs.writeFileSync(path.join(inboxDir, ".tmp", file), JSON.stringify(payload));
			fs.renameSync(path.join(inboxDir, ".tmp", file), path.join(inboxDir, file));
		},
		until: (predicate, options) => untilOutbox(dir, predicate, options),
	};
}

test("status: busy and idle never contradict (one source of truth)", async (t) => {
	// Live-observed on session 01a0345c-ca3: idle:true + busy:true in one report.
	// agentRunning says a turn is open while ctx.isIdle() claims the engine is idle.
	const b = await boot(t, { ctxOptions: { isIdle: () => true } });
	await b.world.fire("agent_start", {}, b.ctx);
	b.drop({ id: "st-contradiction", action: "status" });
	const report = await b.until((r) => r.type === "status_report" && r.id === "st-contradiction");
	assert.equal(report.busy, !report.idle, `contradictory status: idle=${report.idle} busy=${report.busy}`);
});

test("outcome: a settled command's result is queryable after the fact", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	session.emit({ type: "accepted", id: "done-cmd", action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: "done-cmd" });
	session.emit({ type: "agent_settled", owner: "done-cmd", foreignInputSeen: false, text: "work finished" });
	const result = await runCtl(["outcome", session.id, "done-cmd"], agentDir);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const outcome = JSON.parse(result.stdout);
	assert.equal(outcome.state, "completed");
	assert.equal(outcome.text, "work finished");
});

test("outcome: a failed workflow run names the failure, not just an exit code", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	const runId = "aaaabbbb-cccc-4ddd-9eee-ffff00001111";
	session.emit({ type: "accepted", id: "wf-cmd", action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: "wf-cmd" });
	session.emit({ type: "workflow_started", runId, owner: "wf-cmd" });
	session.emit({
		type: "agent_settled",
		owner: "wf-cmd",
		foreignInputSeen: false,
		text: "launched",
		provisional: true,
		pendingWork: [{ kind: "workflow", runId }],
	});
	session.emit({ type: "workflow_lifecycle", runId, kind: "failed", terminal: true, owner: "wf-cmd", text: "stage build failed" });
	const result = await runCtl(["outcome", session.id, "wf-cmd"], agentDir);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const outcome = JSON.parse(result.stdout);
	assert.equal(outcome.state, "failed");
	assert.equal(outcome.runId, runId);
	assert.match(outcome.text ?? "", /stage build failed/);
});

test("send --plan: the plan artifact travels the channel, not only prose", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	const planPath = path.join(agentDir, "plan.json");
	fs.writeFileSync(
		planPath,
		JSON.stringify({ goal: "demo", constraints: [], acceptance: ["tests green"], files: ["src/a.ts"] }),
	);
	const result = await runCtl(["send", session.id, "execute the plan", "--plan", planPath], agentDir);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const [command] = session.readInboxCommands();
	assert.ok(command, "no command reached the inbox");
	assert.equal(command.action, "prompt");
	assert.ok(command.plan, "command carries no structured plan payload");
	assert.equal(command.plan.goal, "demo");
	assert.deepEqual(command.plan.acceptance, ["tests green"]);
});
