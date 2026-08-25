import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeAgentDir, makeSession, runCtl, makeFakePi, makeBridgeCtx, readOutbox, untilOutbox } from "./helpers.mjs";

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
		records: () => readOutbox(dir),
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

test("command action: dispatched with expandPromptTemplates, guarded to leading slash", async (t) => {
	const b = await boot(t);
	b.drop({ id: "cmd-slash", action: "command", message: "/workflow reload" });
	const accepted = await b.until((r) => r.type === "accepted" && r.id === "cmd-slash");
	assert.equal(accepted.delivered, "command");
	const sent = b.world.sent.find((s) => s.message === "/workflow reload");
	assert.equal(sent.options?.expandPromptTemplates, true, "slash text must dispatch as a command, not chat");
	b.drop({ id: "cmd-noslash", action: "command", message: "just chat" });
	const error = await b.until((r) => r.type === "error" && r.id === "cmd-noslash");
	assert.match(error.error, /starting with \//);
});

test("plan on prompt: persisted under plans/ and inlined in the injected message", async (t) => {
	const b = await boot(t);
	const plan = { goal: "ship it", constraints: ["no deps"], acceptance: ["suite green"], context: { files: ["src/x.ts"] } };
	b.drop({ id: "plan-1", action: "prompt", message: "execute the plan", plan });
	const accepted = await b.until((r) => r.type === "accepted" && r.id === "plan-1");
	const planPath = path.join(b.dir, "plans", "plan-1.json");
	assert.equal(accepted.planPath, planPath);
	assert.deepEqual(JSON.parse(fs.readFileSync(planPath, "utf8")), plan);
	const injected = b.world.sent[0].message;
	assert.match(injected, /^execute the plan\n\nPlan artifact \(atomic-remote\/plan@1/);
	assert.match(injected, /"goal": "ship it"/);
	// The turn must bind on the text actually injected, plan block included.
	await b.world.fire("input", { source: "extension", text: injected });
	await b.until((r) => r.type === "turn_bound" && r.id === "plan-1");
});

test("plan validation: rejected on steer, oversized, or non-object", async (t) => {
	const b = await boot(t);
	b.drop({ id: "plan-bad-1", action: "steer", message: "x", plan: { goal: "g" } });
	await b.until((r) => r.type === "error" && r.id === "plan-bad-1" && /only allowed on prompt\/follow_up/.test(r.error));
	b.drop({ id: "plan-bad-2", action: "prompt", message: "x", plan: { blob: "y".repeat(9000) } });
	await b.until((r) => r.type === "error" && r.id === "plan-bad-2" && /plan exceeds 8192 bytes/.test(r.error));
	b.drop({ id: "plan-bad-3", action: "prompt", message: "x", plan: ["not", "an", "object"] });
	await b.until((r) => r.type === "error" && r.id === "plan-bad-3" && /plan must be a JSON object/.test(r.error));
	assert.equal(b.world.sent.length, 0, "no invalid plan may reach the agent");
});

test("run_workflow: installs the TS, reloads, runs, and binds to the run injection", async (t) => {
	const b = await boot(t);
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const meta = JSON.parse(fs.readFileSync(path.join(b.dir, "meta.json"), "utf8"));
	fs.writeFileSync(path.join(b.dir, "meta.json"), JSON.stringify({ ...meta, cwd: targetCwd }, null, 2));
	const source = 'export default workflow({ name: "demo-flow" });\n';
	b.drop({ id: "wf-run-1", action: "run_workflow", workflowName: "demo-flow", workflowSource: source, args: "target=main" });
	const installed = await b.until((r) => r.type === "workflow_installed" && r.id === "wf-run-1");
	const targetPath = path.join(targetCwd, ".atomic", "workflows", "demo-flow.ts");
	assert.equal(installed.targetPath, targetPath);
	assert.equal(installed.overwrote, false);
	assert.equal(fs.readFileSync(targetPath, "utf8"), source);
	await b.until((r) => r.type === "accepted" && r.id === "wf-run-1");
	assert.deepEqual(
		b.world.sent.map((s) => [s.message, s.options?.expandPromptTemplates === true]),
		[
			["/workflow reload", true],
			["/workflow run demo-flow target=main", true],
		],
	);
	await b.world.fire("input", { source: "extension", text: "/workflow run demo-flow target=main" });
	await b.until((r) => r.type === "turn_bound" && r.id === "wf-run-1");
});

test("run_workflow: overwriting an existing workflow file is reported", async (t) => {
	const b = await boot(t);
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const meta = JSON.parse(fs.readFileSync(path.join(b.dir, "meta.json"), "utf8"));
	fs.writeFileSync(path.join(b.dir, "meta.json"), JSON.stringify({ ...meta, cwd: targetCwd }, null, 2));
	fs.mkdirSync(path.join(targetCwd, ".atomic", "workflows"), { recursive: true });
	fs.writeFileSync(path.join(targetCwd, ".atomic", "workflows", "mine.ts"), "// hand-written\n");
	b.drop({ id: "wf-ow", action: "run_workflow", workflowName: "mine", workflowSource: "// generated\n" });
	const installed = await b.until((r) => r.type === "workflow_installed" && r.id === "wf-ow");
	assert.equal(installed.overwrote, true, "clobbering a hand-written workflow must be visible");
});

test("lifecycle: structural notice detected; assistant text quoting a runId is ignored", async (t) => {
	const b = await boot(t);
	const runId = "99998888-abcd-4ef0-9876-aaaabbbbcccc";
	// The v2 regex false positive: assistant text mentioning runId + "workflow completed".
	b.ctx.entries.push({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: `the workflow ${runId} completed earlier, I think` }] },
	});
	// The v2 regex false negative: a real notice whose text has no terminal keyword.
	b.ctx.entries.push({
		type: "custom_message",
		customType: "workflows:lifecycle-notice",
		content: "Run ended without incident",
		details: { kind: "failed", scope: "run", runId, workflowName: "deploy", status: "failed", failedStageId: "build", error: "tsc exit 2" },
	});
	await b.world.fire("agent_start", {}, b.ctx);
	const lifecycles = b.records().filter((r) => r.type === "workflow_lifecycle");
	assert.equal(lifecycles.length, 1, "exactly the structured notice, nothing from assistant prose");
	const record = lifecycles[0];
	assert.equal(record.kind, "failed");
	assert.equal(record.terminal, true);
	assert.equal(record.workflowName, "deploy");
	assert.equal(record.failedStageId, "build");
	assert.equal(record.error, "tsc exit 2");
});

test("lifecycle: stage-scope events are mirrored but never terminal", async (t) => {
	const b = await boot(t);
	const runId = "77776666-abcd-4ef0-9876-ddddeeeeffff";
	b.ctx.entries.push({
		type: "custom_message",
		customType: "workflows:lifecycle-notice",
		content: "Stage build completed",
		details: { kind: "completed", scope: "stage", runId, workflowName: "deploy", status: "running", stageId: "s1", stageName: "build" },
	});
	await b.world.fire("agent_start", {}, b.ctx);
	const record = b.records().find((r) => r.type === "workflow_lifecycle");
	assert.equal(record.scope, "stage");
	assert.equal(record.stageName, "build");
	assert.equal(record.terminal, false, "a stage completing must not end a run-level wait");
	b.drop({ id: "st-pend", action: "status" });
	const report = await b.until((r) => r.type === "status_report" && r.id === "st-pend");
	assert.deepEqual(report.pendingWorkflows, [runId], "the run stays pending after a stage event");
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
