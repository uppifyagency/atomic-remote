import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	makeFakePi,
	makeBridgeCtx,
	makeWorkflowEvents,
	probeWorkflowEvents,
	readOutbox,
	untilOutbox,
} from "./helpers.mjs";

// 0.4.0 contracts: workflow state comes from Atomic's typed workflow hooks
// (workflow_lifecycle / workflow_heartbeat), not from polling session entries.

process.env.ATOMIC_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-0964-test-"));
process.env.ATOMIC_REMOTE_RELOAD_SETTLE_MS = "50";
const bridgeRoot = path.join(process.env.ATOMIC_CODING_AGENT_DIR, "remote-bridge");
const { default: registerBridge } = await import("../atomic-extension/atomic-remote-bridge.ts");

let bootSeq = 0;

async function boot(t, { cwd } = {}) {
	const sessionId = `t64-${String(bootSeq++).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
	const world = makeFakePi();
	registerBridge(world.pi);
	const ctx = makeBridgeCtx({ sessionId });
	await world.fire("session_start", { reason: "startup" }, ctx);
	t.after(() => world.fire("session_shutdown", { reason: "quit" }));
	const dir = path.join(bridgeRoot, sessionId);
	const inboxDir = path.join(dir, "inbox");
	if (cwd) {
		const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
		fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...meta, cwd }, null, 2));
	}
	let dropSeq = 0;
	const ev = makeWorkflowEvents(sessionId);
	return {
		world,
		ctx,
		dir,
		sessionId,
		inboxDir,
		ev,
		drop(payload) {
			const file = `${String(Date.now()).padStart(14, "0")}-${String(dropSeq++).padStart(3, "0")}-drop.json`;
			fs.writeFileSync(path.join(inboxDir, ".tmp", file), JSON.stringify(payload));
			fs.renameSync(path.join(inboxDir, ".tmp", file), path.join(inboxDir, file));
		},
		hook: (event) => world.fire(event.type, event, ctx),
		records: () => readOutbox(dir),
		lifecycles: () => readOutbox(dir).filter((r) => r.type === "workflow_lifecycle"),
		until: (predicate, options) => untilOutbox(dir, predicate, options),
		async status(id) {
			this.drop({ id, action: "status" });
			return untilOutbox(dir, (r) => r.type === "status_report" && r.id === id);
		},
	};
}

test("probe replay: the live 0.9.64 sequence mirrors run start, every stage transition and the terminal", async (t) => {
	const b = await boot(t);
	const events = probeWorkflowEvents(b.sessionId);
	const runId = events.find((e) => e.type === "workflow_lifecycle").runId;
	for (const event of events) await b.hook(event);

	const lifecycles = b.lifecycles();
	assert.deepEqual(
		lifecycles.map((r) => `${r.scope}:${r.kind}`),
		[
			"run:started",
			"stage:pending",
			"stage:running",
			"stage:awaiting_input",
			"stage:running",
			"stage:awaiting_input",
			"stage:running",
			"stage:completed",
			"run:completed",
		],
	);
	assert.ok(lifecycles.every((r) => r.runId === runId));
	assert.deepEqual(
		lifecycles.map((r) => r.terminal),
		[false, false, false, false, false, false, false, false, true],
		"only the run reaching completed is terminal",
	);
	assert.equal(lifecycles[1].stageName, "ask");
	assert.equal(b.records().some((r) => r.type === "workflow_started"), false, "a user-started run has no remote launcher");
	const report = await b.status("st-probe");
	assert.deepEqual(report.pendingWorkflows, []);
});

test("a run is pending from its typed start until its typed terminal", async (t) => {
	const b = await boot(t);
	const runId = "0a0a0a0a-abcd-4ef0-9876-000000000001";
	await b.hook(b.ev.run(runId, "running"));
	assert.deepEqual((await b.status("st-1")).pendingWorkflows, [runId]);
	await b.hook(b.ev.run(runId, "completed", "running"));
	assert.deepEqual((await b.status("st-2")).pendingWorkflows, []);
});

test("events owned by another session are not mirrored", async (t) => {
	const b = await boot(t);
	const runId = "0a0a0a0a-abcd-4ef0-9876-000000000002";
	await b.hook(b.ev.run(runId, "running", undefined, { owner: "some-other-session" }));
	await b.hook(b.ev.heartbeat(runId, { owner: "some-other-session" }));
	assert.equal(b.records().filter((r) => r.type.startsWith("workflow_")).length, 0);
});

test("a re-delivered event id is mirrored once", async (t) => {
	const b = await boot(t);
	const runId = "0a0a0a0a-abcd-4ef0-9876-000000000003";
	const event = b.ev.run(runId, "completed", "running");
	await b.hook(event);
	await b.hook(event);
	assert.equal(b.lifecycles().filter((r) => r.kind === "completed").length, 1);
});

test("replay delivery (a resumed run re-executing finished stages) is not mirrored as live progress", async (t) => {
	const b = await boot(t);
	const runId = "0a0a0a0a-abcd-4ef0-9876-000000000004";
	await b.hook(b.ev.run(runId, "running"));
	await b.hook(b.ev.stage(runId, "s1", "build", "completed", "running", { delivery: "replay" }));
	assert.equal(b.lifecycles().filter((r) => r.scope === "stage").length, 0);
});

test("a lifecycle notice in the transcript is not mirrored a second time", async (t) => {
	const b = await boot(t);
	const runId = "0a0a0a0a-abcd-4ef0-9876-000000000005";
	await b.hook(b.ev.run(runId, "running"));
	b.ctx.entries.push({
		type: "custom_message",
		customType: "workflows:lifecycle-notice",
		id: "e-dup-1",
		content: `✓ Workflow "demo" completed (run ${runId}).`,
		details: { kind: "completed", scope: "run", runId, workflowName: "demo", status: "completed" },
	});
	await b.hook(b.ev.run(runId, "completed", "running"));
	await b.world.fire("agent_start", {}, b.ctx);
	await b.world.fire("agent_settled", {}, b.ctx);
	assert.equal(b.lifecycles().filter((r) => r.terminal).length, 1, "exactly one terminal record per run");
});

test("workflowName comes from the run's start entry; a failed run names its failed stage and error", async (t) => {
	const b = await boot(t);
	const runId = "0a0a0a0a-abcd-4ef0-9876-000000000006";
	b.ctx.entries.push({ type: "custom", customType: "workflow.run.start", id: "e-rs", data: { runId, name: "deploy" } });
	await b.hook(b.ev.run(runId, "running"));
	await b.hook(b.ev.stage(runId, "s-build", "build", "running", "pending"));
	await b.hook(b.ev.stage(runId, "s-build", "build", "failed", "running"));
	b.ctx.entries.push({
		type: "custom",
		customType: "workflow.run.end",
		id: "e-re",
		data: { runId, status: "failed", error: "tsc exit 2", failedStageId: "s-build" },
	});
	await b.hook(b.ev.run(runId, "failed", "running"));
	const terminal = b.lifecycles().find((r) => r.terminal);
	assert.equal(terminal.kind, "failed");
	assert.equal(terminal.workflowName, "deploy");
	assert.equal(terminal.failedStageId, "s-build");
	assert.equal(terminal.stageName, "build");
	assert.equal(terminal.error, "tsc exit 2");
});

test("a nested child run reports on its root and never becomes a pending run of its own", async (t) => {
	const b = await boot(t);
	const root = "0a0a0a0a-abcd-4ef0-9876-000000000007";
	const child = "0b0b0b0b-abcd-4ef0-9876-000000000007";
	await b.hook(b.ev.run(root, "running"));
	await b.hook(b.ev.run(child, "running", undefined, { rootRunId: root }));
	await b.hook(b.ev.stage(child, `${child}:s1`, "inner", "running", "pending", { rootRunId: root }));
	await b.hook(b.ev.run(child, "completed", "running", { rootRunId: root }));
	assert.deepEqual((await b.status("st-nest")).pendingWorkflows, [root], "a child completing does not end the root");
	const stage = b.lifecycles().find((r) => r.scope === "stage");
	assert.equal(stage.runId, root);
	assert.equal(stage.stageName, "inner");
});

test("typed heartbeats are mirrored as workflow_heartbeat records", async (t) => {
	const b = await boot(t);
	const runId = "0a0a0a0a-abcd-4ef0-9876-000000000008";
	b.ctx.entries.push({ type: "custom", customType: "workflow.run.start", id: "e-hb", data: { runId, name: "long-flow" } });
	await b.hook(b.ev.run(runId, "running"));
	await b.hook(b.ev.heartbeat(runId));
	const hb = b.records().find((r) => r.type === "workflow_heartbeat");
	assert.equal(hb?.runId, runId);
	assert.equal(hb?.workflowName, "long-flow");
});

test("a quit run is terminal; resuming it makes it pending again", async (t) => {
	const b = await boot(t);
	const runId = "0a0a0a0a-abcd-4ef0-9876-000000000009";
	await b.hook(b.ev.run(runId, "running"));
	await b.hook(b.ev.run(runId, "running", undefined, { action: "quit" }));
	await b.hook(b.ev.run(runId, "paused", "running"));
	const quit = b.lifecycles().find((r) => r.kind === "quit");
	assert.equal(quit?.terminal, true);
	assert.deepEqual((await b.status("st-q1")).pendingWorkflows, []);
	await b.hook(b.ev.run(runId, "running", "paused"));
	assert.equal(b.lifecycles().at(-1).kind, "resumed");
	assert.deepEqual((await b.status("st-q2")).pendingWorkflows, [runId]);
});

test("run_workflow: the typed start of the launched workflow is attributed to the command", async (t) => {
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const b = await boot(t, { cwd: targetCwd });
	b.drop({ id: "wf-typed", action: "run_workflow", workflowName: "demo-flow", workflowSource: "// x\n" });
	await b.until((r) => r.type === "accepted" && r.id === "wf-typed");
	const runId = "0a0a0a0a-abcd-4ef0-9876-00000000000a";
	b.ctx.entries.push({ type: "custom", customType: "workflow.run.start", id: "e-l1", data: { runId, name: "demo-flow" } });
	await b.hook(b.ev.run(runId, "running"));
	const started = b.records().find((r) => r.type === "workflow_started" && r.runId === runId);
	assert.equal(started?.owner, "wf-typed");
	assert.equal(b.lifecycles()[0].owner, "wf-typed");
});

test("run_workflow: a run of a different workflow started meanwhile is not claimed", async (t) => {
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const b = await boot(t, { cwd: targetCwd });
	b.drop({ id: "wf-other", action: "run_workflow", workflowName: "demo-flow", workflowSource: "// x\n" });
	await b.until((r) => r.type === "accepted" && r.id === "wf-other");
	const other = "0a0a0a0a-abcd-4ef0-9876-00000000000b";
	b.ctx.entries.push({ type: "custom", customType: "workflow.run.start", id: "e-o1", data: { runId: other, name: "hand-made" } });
	await b.hook(b.ev.run(other, "running"));
	assert.equal(b.lifecycles()[0].owner, null, "a different workflow must not inherit the launch");
	const mine = "0a0a0a0a-abcd-4ef0-9876-00000000000c";
	b.ctx.entries.push({ type: "custom", customType: "workflow.run.start", id: "e-o2", data: { runId: mine, name: "demo-flow" } });
	await b.hook(b.ev.run(mine, "running"));
	assert.equal(b.records().find((r) => r.type === "workflow_started" && r.runId === mine)?.owner, "wf-other");
});

test("run_workflow: an agent-launched run is left to the workflow tool's attribution", async (t) => {
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const b = await boot(t, { cwd: targetCwd });
	b.drop({ id: "wf-agent", action: "run_workflow", workflowName: "demo-flow", workflowSource: "// x\n" });
	await b.until((r) => r.type === "accepted" && r.id === "wf-agent");
	const runId = "0a0a0a0a-abcd-4ef0-9876-00000000000d";
	await b.hook(b.ev.run(runId, "running", undefined, { attribution: "agent" }));
	assert.equal(b.lifecycles()[0].owner, null);
});

test("reload: a fresh instance keeps in-flight runs and drops runs that ended while it was away", async (t) => {
	const b = await boot(t);
	const alive = "0a0a0a0a-abcd-4ef0-9876-00000000000e";
	const ended = "0a0a0a0a-abcd-4ef0-9876-00000000000f";
	await b.hook(b.ev.run(alive, "running"));
	await b.hook(b.ev.run(ended, "running"));
	assert.deepEqual((await b.status("st-r1")).pendingWorkflows.sort(), [alive, ended].sort());

	await b.world.fire("session_shutdown", { reason: "reload" });
	// The run finished during the reload gap: Atomic never re-delivers its
	// lifecycle to the new instance, but its run.end entry is in the transcript.
	b.ctx.entries.push({ type: "custom", customType: "workflow.run.end", id: "e-gap", data: { runId: ended, status: "completed" } });
	const world2 = makeFakePi();
	registerBridge(world2.pi);
	await world2.fire("session_start", { reason: "reload" }, b.ctx);
	t.after(() => world2.fire("session_shutdown", { reason: "quit" }));
	assert.deepEqual((await b.status("st-r2")).pendingWorkflows, [alive]);
	await world2.fire("workflow_lifecycle", b.ev.run(alive, "completed", "running"), b.ctx);
	assert.deepEqual((await b.status("st-r3")).pendingWorkflows, []);
});
