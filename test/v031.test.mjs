import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakePi, makeBridgeCtx, readOutbox, untilOutbox } from "./helpers.mjs";

// 0.3.1 contracts (ROADMAP TOP 5). Written red against the 0.3.0 baseline.
// RELOAD_SETTLE_MS is shrunk through its test seam so run_workflow tests do
// not each pay the production 5 s settle; the two-lane test still needs the
// settle to be much larger than delivery latency.
process.env.ATOMIC_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-v031-test-"));
process.env.ATOMIC_REMOTE_RELOAD_SETTLE_MS = "1200";
const bridgeRoot = path.join(process.env.ATOMIC_CODING_AGENT_DIR, "remote-bridge");
const { default: registerBridge } = await import("../atomic-extension/atomic-remote-bridge.ts");

let bootSeq = 0;

async function boot(t, { piOptions = {}, ctxOptions = {}, cwd } = {}) {
	const sessionId = `v31-${String(bootSeq++).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
	const world = makeFakePi(piOptions);
	registerBridge(world.pi);
	const ctx = makeBridgeCtx({ sessionId, ...ctxOptions });
	await world.fire("session_start", { reason: "startup" }, ctx);
	t.after(() => world.fire("session_shutdown", { reason: "quit" }));
	const dir = path.join(bridgeRoot, sessionId);
	const inboxDir = path.join(dir, "inbox");
	if (cwd) {
		const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
		fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...meta, cwd }, null, 2));
	}
	let dropSeq = 0;
	return {
		world,
		ctx,
		dir,
		sessionId,
		inboxDir,
		drop(payload) {
			const file = `${String(Date.now()).padStart(14, "0")}-${String(dropSeq++).padStart(3, "0")}-drop.json`;
			fs.writeFileSync(path.join(inboxDir, ".tmp", file), JSON.stringify(payload));
			fs.renameSync(path.join(inboxDir, ".tmp", file), path.join(inboxDir, file));
		},
		records: () => readOutbox(dir),
		until: (predicate, options) => untilOutbox(dir, predicate, options),
	};
}

function startedNotice(runId, workflowName, entryId) {
	return {
		type: "custom_message",
		customType: "workflows:lifecycle-notice",
		id: entryId,
		content: `Workflow ${workflowName} started`,
		details: { kind: "started", scope: "run", runId, workflowName, status: "running" },
	};
}

const wfSource = 'export default workflow({ name: "x" });\n';

// --- item 1: attribution -----------------------------------------------------

test("item1: pendingWorkflowLaunch does not survive a session switch", async (t) => {
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const b = await boot(t, { cwd: targetCwd });
	b.drop({ id: "wf-leak", action: "run_workflow", workflowName: "ghost-flow", workflowSource: wfSource });
	await b.until((r) => r.type === "accepted" && r.id === "wf-leak");

	const nextId = `v31-next-${Math.random().toString(36).slice(2, 8)}`;
	const nextCtx = makeBridgeCtx({ sessionId: nextId });
	await b.world.fire("session_start", { reason: "new" }, nextCtx);
	t.after(() => b.world.fire("session_shutdown", { reason: "quit" }));

	const runId = "0f0f0f0f-abcd-4ef0-9876-000011112222";
	nextCtx.entries.push(startedNotice(runId, "ghost-flow", "e-leak-1"));
	await b.world.fire("agent_start", {}, nextCtx);
	const records = readOutbox(path.join(bridgeRoot, nextId));
	const lifecycle = records.find((r) => r.type === "workflow_lifecycle" && r.kind === "started");
	assert.ok(lifecycle, "the user-launched run must still be registered");
	assert.equal(lifecycle.owner, null, "a launch armed in the previous session must not claim this run");
	assert.equal(
		records.filter((r) => r.type === "workflow_started" && r.owner === "wf-leak").length,
		0,
		"the dead command must not be reported as the launcher",
	);
});

test("item1: a failed launch injection disarms the pending launch", async (t) => {
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const b = await boot(t, {
		cwd: targetCwd,
		piOptions: {
			sendUserMessage: (message) => {
				if (message.startsWith("/workflow ghost")) throw new Error("boom at launch");
			},
		},
	});
	b.drop({ id: "wf-fail", action: "run_workflow", workflowName: "ghost", workflowSource: wfSource });
	await b.until((r) => r.type === "error" && r.id === "wf-fail");

	// The user relaunches the same-named workflow by hand: it must not be
	// attributed to the dead command.
	const runId = "1a1a1a1a-abcd-4ef0-9876-333344445555";
	b.ctx.entries.push(startedNotice(runId, "ghost", "e-fail-1"));
	await b.world.fire("agent_start", {}, b.ctx);
	const lifecycle = b.records().find((r) => r.type === "workflow_lifecycle" && r.kind === "started");
	assert.ok(lifecycle, "the manual run must still be registered");
	assert.equal(lifecycle.owner, null, "a failed launch must disarm attribution");
	assert.equal(
		b.records().filter((r) => r.type === "workflow_started" && r.owner === "wf-fail").length,
		0,
		"the dead command must not be reported as the launcher",
	);
});

test("item1: late agent_end from the aborted run cannot steal the interrupt's settle", async (t) => {
	let idleNow = false;
	const b = await boot(t, { ctxOptions: { isIdle: () => idleNow } });
	b.drop({ id: "old-cmd", action: "prompt", message: "long job" });
	await b.until((r) => r.type === "accepted" && r.id === "old-cmd");
	await b.world.fire("input", { source: "extension", text: "long job" });
	await b.world.fire("agent_start", {}, b.ctx);

	b.drop({ id: "int-cmd", action: "interrupt", message: "drop everything" });
	await b.until((r) => r.type === "accepted" && r.id === "int-cmd");

	// Broken interleaving: the interrupt's turn starts FIRST, then the aborted
	// run's late agent_end and settle arrive while the interrupt turn streams.
	await b.world.fire("agent_start", {}, b.ctx);
	await b.world.fire("agent_end", { messages: [] }); // late end from the aborted run
	idleNow = false; // interrupt turn still streaming at the aborted settle
	await b.world.fire("agent_settled", {}, b.ctx);
	idleNow = true;
	await b.world.fire("agent_end", {
		messages: [{ role: "assistant", content: [{ type: "text", text: "INTERRUPT-REPLY" }] }],
	});
	await b.world.fire("agent_settled", {}, b.ctx);

	const settles = b.records().filter((r) => r.type === "agent_settled");
	assert.equal(settles.length, 2);
	assert.equal(settles[0].owner, "old-cmd", "the aborted settle belongs to the preempted command");
	assert.equal(settles[0].aborted, true);
	assert.equal(settles[1].owner, "int-cmd", "the interrupt's settle must keep its owner");
	assert.equal(settles[1].text, "INTERRUPT-REPLY");
});

test("item1: interrupt carries interruptAbortMessage naming the command", async (t) => {
	const b = await boot(t);
	b.drop({ id: "int-abm", action: "interrupt", message: "redirect" });
	await b.until((r) => r.type === "accepted" && r.id === "int-abm");
	const sent = b.world.sent.find((s) => s.kind === "custom");
	assert.match(String(sent.options.interruptAbortMessage), /atomic-remote command int-abm/);
});

// --- item 2: HIL visibility ----------------------------------------------------

import { makeAgentDir, makeSession, runCtl } from "./helpers.mjs";

function writeStatusFile(projDir, runs) {
	const file = path.join(projDir, ".atomic", "workflows", "status.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ runs, notices: [], version: 3 }, null, 2));
	return file;
}

test("item2: workflow heartbeat cards are mirrored as workflow_heartbeat records", async (t) => {
	const b = await boot(t);
	const runId = "3c3c3c3c-abcd-4ef0-9876-99990000aaaa";
	b.ctx.entries.push(startedNotice(runId, "long-flow", "e-hb-0"));
	await b.world.fire("agent_start", {}, b.ctx);
	b.ctx.entries.push({
		type: "custom_message",
		customType: "workflows:workflow-heartbeat",
		id: "e-hb-1",
		content: "long-flow still running (15m elapsed)",
		details: { runId, workflowName: "long-flow", scheduledAt: Date.now() },
	});
	await b.world.fire("agent_settled", {}, b.ctx);
	const hb = b.records().find((r) => r.type === "workflow_heartbeat");
	assert.ok(hb, "the heartbeat card must be mirrored");
	assert.equal(hb.runId, runId);
	assert.equal(hb.workflowName, "long-flow");
	assert.match(hb.text, /still running/);
});

test("item2: status merges the workflow statusFile when the project provides it", async () => {
	const agentDir = makeAgentDir();
	const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-proj-"));
	const runId = "4d4d4d4d-abcd-4ef0-9876-bbbbccccdddd";
	writeStatusFile(projDir, [{ id: runId, name: "deploy", status: "awaiting_input" }]);
	const session = makeSession(agentDir, { cwd: projDir });
	const ctl = runCtl(["status", session.id], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "status_report", id: cmd.id, idle: true, busy: false, pendingWorkflows: [runId], protocol: 3 });
	const result = await ctl;
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const report = JSON.parse(result.stdout);
	assert.ok(report.workflowStatus, "the report must carry the statusFile view");
	assert.equal(report.workflowStatus.runs[0].runId, runId);
	assert.equal(report.workflowStatus.runs[0].status, "awaiting_input");
});

test("item2: status hints at statusFile when runs are pending and the file is absent", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir, { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-proj-")) });
	const ctl = runCtl(["status", session.id], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({
		type: "status_report",
		id: cmd.id,
		idle: false,
		busy: true,
		pendingWorkflows: ["5e5e5e5e-abcd-4ef0-9876-eeeeffff0000"],
		protocol: 3,
	});
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.match(result.stderr, /statusFile/, "pending runs with no statusFile must earn the enablement hint");
});

test("item2: answer injects a follow_up instructing the workflow send/answer call", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	const runId = "6f6f6f6f-abcd-4ef0-9876-111122223333";
	const result = await runCtl(["answer", session.id, runId, "yes, proceed with plan B"], agentDir);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const [cmd] = session.readInboxCommands();
	assert.ok(cmd, "no command reached the inbox");
	assert.equal(cmd.action, "follow_up");
	assert.ok(cmd.message.includes(runId), "the instruction must name the run");
	assert.match(cmd.message, /"action":\s*"send"/);
	assert.match(cmd.message, /"delivery":\s*"answer"/);
	assert.ok(cmd.message.includes("yes, proceed with plan B"));
});

test("item2: answer rejects a non-UUID run id before touching the inbox", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	const result = await runCtl(["answer", session.id, "6f6f6f6f", "text"], agentDir);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /36-character UUID/);
	assert.equal(session.readInboxCommands().length, 0);
});

test("item2: outcome marks detached runs that are awaiting human input", async () => {
	const agentDir = makeAgentDir();
	const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-proj-"));
	const runId = "7a7a7a7a-abcd-4ef0-9876-444455556666";
	writeStatusFile(projDir, [{ id: runId, name: "release", status: "awaiting_input" }]);
	const session = makeSession(agentDir, { cwd: projDir });
	session.emit({ type: "accepted", id: "hil-cmd", action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: "hil-cmd" });
	session.emit({ type: "workflow_started", runId, owner: "hil-cmd" });
	session.emit({
		type: "agent_settled",
		owner: "hil-cmd",
		foreignInputSeen: false,
		text: "launched",
		provisional: true,
		pendingWork: [{ kind: "workflow", runId }],
	});
	const result = await runCtl(["outcome", session.id, "hil-cmd"], agentDir);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const outcome = JSON.parse(result.stdout);
	assert.equal(outcome.state, "detached");
	assert.equal(outcome.runs[0].awaitingInput, true, "the detached run must be marked as waiting for a human");
});

test("item2: exit 7 names the awaiting-input run and points at answer", async () => {
	const agentDir = makeAgentDir();
	const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-proj-"));
	const runId = "8b8b8b8b-abcd-4ef0-9876-777788889999";
	writeStatusFile(projDir, [{ id: runId, name: "release", status: "awaiting_input" }]);
	const session = makeSession(agentDir, { cwd: projDir });
	const ctl = runCtl(["send", session.id, "slow workflow", "--wait", "--idle-timeout", "1"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "workflow_started", runId, owner: cmd.id });
	const result = await ctl;
	assert.equal(result.code, 7);
	assert.match(result.stderr, /awaiting human input/);
	assert.match(result.stderr, /answer /, "the unblock path must be named");
});

// --- item 3: two-lane command queue ---------------------------------------------

test("item3: control actions answer while an injection command is still settling", async (t) => {
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const b = await boot(t, { cwd: targetCwd });
	// run_workflow sleeps RELOAD_SETTLE_MS (1200ms here, 5s in production) on
	// the injection lane; status and abort must not wait behind it.
	b.drop({ id: "wf-slow", action: "run_workflow", workflowName: "slow-flow", workflowSource: wfSource });
	b.drop({ id: "st-fast", action: "status" });
	await b.until((r) => r.type === "status_report" && r.id === "st-fast");
	assert.equal(
		b.records().some((r) => r.type === "accepted" && r.id === "wf-slow"),
		false,
		"status answered only after the reload settle: control actions are stuck in the injection lane",
	);
	await b.until((r) => r.type === "accepted" && r.id === "wf-slow");
});

test("item3: abort bypasses the injection lane", async (t) => {
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const b = await boot(t, { cwd: targetCwd });
	let aborted = false;
	b.ctx.abort = () => {
		aborted = true;
	};
	b.drop({ id: "wf-slow2", action: "run_workflow", workflowName: "slow-two", workflowSource: wfSource });
	b.drop({ id: "ab-fast", action: "abort" });
	await b.until((r) => r.type === "accepted" && r.id === "ab-fast");
	assert.equal(aborted, true);
	assert.equal(
		b.records().some((r) => r.type === "accepted" && r.id === "wf-slow2"),
		false,
		"abort must land before the reload settle finishes",
	);
	await b.until((r) => r.type === "accepted" && r.id === "wf-slow2");
});

// --- item 4: total order and honest replay --------------------------------------

test("item4: every outbox record carries a strictly increasing seq", async (t) => {
	const b = await boot(t);
	b.drop({ id: "seq-1", action: "ping" });
	await b.until((r) => r.type === "pong" && r.id === "seq-1");
	b.drop({ id: "seq-2", action: "ping" });
	await b.until((r) => r.type === "pong" && r.id === "seq-2");
	const seqs = b.records().map((r) => r.seq);
	assert.ok(seqs.every((s) => typeof s === "number"), `every record needs a seq, got: ${JSON.stringify(seqs)}`);
	for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], "seq must be strictly increasing");
});

test("item4: two same-millisecond records are both delivered when seq is present", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	const ts = new Date().toISOString();
	fs.appendFileSync(
		session.outboxPath,
		`${JSON.stringify({ type: "foreign_input", preview: "first", seq: 101, ts })}\n` +
			`${JSON.stringify({ type: "foreign_input", preview: "second", seq: 102, ts })}\n`,
	);
	const result = await runCtl(["follow", session.id, "--for", "1"], agentDir);
	assert.equal(result.code, 0);
	const previews = result.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).preview);
	assert.deepEqual(previews, ["first", "second"], "same-ms records must not collapse in the dedupe");
});

test("item4: tail reads the rotated generation like outcome does", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	session.emit({ type: "accepted", id: "old-gen", action: "prompt" });
	session.rotateOutbox();
	session.emit({ type: "accepted", id: "new-gen", action: "prompt" });
	const result = await runCtl(["tail", session.id, "--lines", "10"], agentDir);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /old-gen/, "pre-rotation history must stay visible to tail");
	assert.match(result.stdout, /new-gen/);
});

test("item4: outcome replays a completed steer as completed, not working", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	session.emit({ type: "accepted", id: "steer-cmd", action: "steer", delivered: "steer", contended: true });
	session.emit({ type: "agent_settled", owner: null, foreignInputSeen: false, text: "steered outcome" });
	const result = await runCtl(["outcome", session.id, "steer-cmd"], agentDir);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const outcome = JSON.parse(result.stdout);
	assert.equal(outcome.state, "completed", "a weakly-owned steer settle must resolve in replay too");
	assert.equal(outcome.text, "steered outcome");
});

test("item4: outcome replay of a steer ignores innocuous foreign input", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	session.emit({ type: "accepted", id: "steer-fi", action: "steer", delivered: "steer", contended: true });
	session.emit({ type: "foreign_input", preview: "unrelated typing" });
	session.emit({ type: "agent_settled", owner: null, foreignInputSeen: false, text: "still fine" });
	const result = await runCtl(["outcome", session.id, "steer-fi"], agentDir);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const outcome = JSON.parse(result.stdout);
	assert.notEqual(outcome.state, "uncertain", "foreign input must not poison a non-prompt replay");
});

test("item4: a /reload does not re-emit already-mirrored workflow history", async (t) => {
	const b = await boot(t);
	const runId = "9c9c9c9c-abcd-4ef0-9876-aaaa1111bbbb";
	b.ctx.entries.push({
		type: "custom_message",
		customType: "workflows:lifecycle-notice",
		id: "e-cursor-1",
		content: "Workflow demo completed",
		details: { kind: "completed", scope: "run", runId, workflowName: "demo", status: "completed" },
	});
	await b.world.fire("agent_start", {}, b.ctx);
	assert.equal(b.records().filter((r) => r.type === "workflow_lifecycle").length, 1);

	// /reload: same session id, same entries, fresh extension state.
	await b.world.fire("session_start", { reason: "reload" }, b.ctx);
	await b.world.fire("agent_start", {}, b.ctx);
	assert.equal(
		b.records().filter((r) => r.type === "workflow_lifecycle").length,
		1,
		"the durable entry cursor must survive a reload",
	);
});

// --- item 5: verified command surface --------------------------------------------

test("item5: an unknown slash command is refused with the available names", async (t) => {
	const b = await boot(t, { piOptions: { commands: [{ name: "workflow" }, { name: "skill:tdd" }] } });
	b.drop({ id: "cmd-bad", action: "command", message: "/nonexistent arg" });
	const error = await b.until((r) => r.type === "error" && r.id === "cmd-bad");
	assert.match(error.error, /unknown slash command: \/nonexistent/);
	assert.ok(error.available.includes("workflow"), "the refusal must teach the available surface");
	assert.equal(b.world.sent.length, 0, "an unknown command must never reach the agent as chat");
});

test("item5: a known slash command still dispatches", async (t) => {
	const b = await boot(t, { piOptions: { commands: [{ name: "workflow" }, { name: "skill:tdd" }] } });
	b.drop({ id: "cmd-ok", action: "command", message: "/skill:tdd go" });
	const accepted = await b.until((r) => r.type === "accepted" && r.id === "cmd-ok");
	assert.equal(accepted.delivered, "command");
});

test("item5: without getCommands the bridge stays permissive", async (t) => {
	const b = await boot(t);
	b.drop({ id: "cmd-perm", action: "command", message: "/anything goes" });
	await b.until((r) => r.type === "accepted" && r.id === "cmd-perm");
});

test("item5: status include=commands lists the command surface", async (t) => {
	const b = await boot(t, { piOptions: { commands: [{ name: "workflow" }, { name: "skill:tdd" }] } });
	b.drop({ id: "st-cmds", action: "status", include: ["commands"] });
	const report = await b.until((r) => r.type === "status_report" && r.id === "st-cmds");
	assert.deepEqual(report.commands, ["workflow", "skill:tdd"]);
	b.drop({ id: "st-plain", action: "status" });
	const plain = await b.until((r) => r.type === "status_report" && r.id === "st-plain");
	assert.equal("commands" in plain, false, "the surface list is opt-in: the outbox stays lean");
});

test("item5: ctl status --commands asks the bridge for the surface", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	const ctl = runCtl(["status", session.id, "--commands"], agentDir);
	const cmd = await session.nextInboxCommand();
	assert.deepEqual(cmd.include, ["commands"]);
	session.emit({ type: "status_report", id: cmd.id, idle: true, busy: false, pendingWorkflows: [], commands: ["workflow"] });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.match(result.stdout, /"commands"/);
});

// --- review findings (cross-model pass) -------------------------------------------

test("review: the binding table is capped at default TTLs — oldest evicted, named", async (t) => {
	const b = await boot(t);
	for (let i = 0; i < 33; i++) {
		b.drop({ id: `cap-${String(i).padStart(2, "0")}`, action: "prompt", message: `unique text ${i}` });
	}
	const evicted = await b.until((r) => r.type === "binding_expired" && r.reason === "evicted");
	assert.equal(evicted.id, "cap-00", "eviction must drop the oldest binding first and name it");
});

test("review: in-flight workflow tracking survives a reload into a FRESH extension instance", async (t) => {
	const b = await boot(t);
	const runId = "5a5a5a5a-abcd-4ef0-9876-cccc2222dddd";
	b.ctx.entries.push(startedNotice(runId, "long-haul", "e-fresh-1"));
	await b.world.fire("agent_start", {}, b.ctx);
	b.drop({ id: "st-before", action: "status" });
	const before = await b.until((r) => r.type === "status_report" && r.id === "st-before");
	assert.deepEqual(before.pendingWorkflows, [runId]);

	// A real /reload: the old instance is torn down FIRST (otherwise it keeps
	// consuming the shared inbox and the test greenwashes itself), then a
	// brand-new extension instance (new closure, empty knownRuns) starts on
	// the same session dir with the same entries.
	await b.world.fire("session_shutdown", { reason: "reload" });
	const world2 = makeFakePi();
	registerBridge(world2.pi);
	await world2.fire("session_start", { reason: "reload" }, b.ctx);
	t.after(() => world2.fire("session_shutdown", { reason: "quit" }));
	const drop2 = (payload) => {
		const file = `${String(Date.now()).padStart(14, "0")}-900-drop2.json`;
		fs.writeFileSync(path.join(b.inboxDir, ".tmp", file), JSON.stringify(payload));
		fs.renameSync(path.join(b.inboxDir, ".tmp", file), path.join(b.inboxDir, file));
	};
	drop2({ id: "st-after", action: "status" });
	const after = await b.until((r) => r.type === "status_report" && r.id === "st-after");
	assert.deepEqual(
		after.pendingWorkflows,
		[runId],
		"the durable cursor must not skip past runs that are still in flight",
	);
	// And the cursor still prevents re-emission of the mirrored history.
	await world2.fire("agent_start", {}, b.ctx);
	assert.equal(b.records().filter((r) => r.type === "workflow_lifecycle").length, 1);
});

test("review: getCommands names with a leading slash still validate", async (t) => {
	const b = await boot(t, { piOptions: { commands: [{ name: "/workflow" }, { name: "/skill:tdd" }] } });
	b.drop({ id: "cmd-slashname", action: "command", message: "/workflow reload" });
	const accepted = await b.until((r) => r.type === "accepted" && r.id === "cmd-slashname");
	assert.equal(accepted.delivered, "command");
});

test("review: status --commands against a bridge that ignores include gets a warning", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir);
	const ctl = runCtl(["status", session.id, "--commands"], agentDir);
	const cmd = await session.nextInboxCommand();
	// An old bridge drops the include key and answers without a commands field.
	session.emit({ type: "status_report", id: cmd.id, idle: true, busy: false, pendingWorkflows: [], protocol: 3 });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.match(result.stderr, /does not support --commands|ignora|ignores/i);
});
