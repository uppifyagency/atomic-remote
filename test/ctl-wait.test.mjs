import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAgentDir, makeSession, runCtl, sleep } from "./helpers.mjs";

function armedSession() {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir, { id: `w-${Math.random().toString(36).slice(2, 10)}`, name: "w" });
	return { agentDir, session };
}

test("ping: pong round-trip exits 0", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["ping", session.id], agentDir);
	const cmd = await session.nextInboxCommand();
	assert.equal(cmd.action, "ping");
	session.emit({ type: "pong", id: cmd.id, protocol: 2, bridgeVersion: "0.2.1" });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.match(result.stdout, /pong/);
});

test("status: prints the status_report and exits 0", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["status", session.id], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "status_report", id: cmd.id, idle: true, busy: false, pendingWorkflows: [], protocol: 2 });
	const result = await ctl;
	assert.equal(result.code, 0);
	const report = JSON.parse(result.stdout);
	assert.equal(report.idle, true);
	assert.equal(report.type, "status_report");
});

test("abort: accepted ack completes the command", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["abort", session.id], agentDir);
	const cmd = await session.nextInboxCommand();
	assert.equal(cmd.action, "abort");
	session.emit({ type: "accepted", id: cmd.id, action: "abort", contended: false });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.match(result.stdout, /abort delivered/);
});

test("send --wait: attributed settle prints the reply, exit 0", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "do the thing", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	assert.equal(cmd.action, "prompt");
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: cmd.id });
	session.emit({ type: "agent_settled", owner: cmd.id, foreignInputSeen: false, text: "all tests pass" });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.equal(result.stdout.trim(), "all tests pass");
});

test("send --wait: settle with no assistant text still exits 0 with a placeholder", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "quiet task", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: cmd.id });
	session.emit({ type: "agent_settled", owner: cmd.id, foreignInputSeen: false, text: null });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.match(result.stdout, /no assistant text/);
});

test("send --wait: foreign input before binding abandons attribution, exit 6", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "risky", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "foreign_input", preview: "user typed here" });
	const result = await ctl;
	assert.equal(result.code, 6);
	assert.match(result.stderr, /Attribution abandoned/);
	assert.equal(result.stdout.trim(), "", "nothing may be printed as the reply on exit 6");
});

test("send --wait: owned settle contaminated by foreign input exits 6; --accept-partial takes it", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "task", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: cmd.id });
	session.emit({ type: "agent_settled", owner: cmd.id, foreignInputSeen: true, text: "mixed reply" });
	const strict = await ctl;
	assert.equal(strict.code, 6);
	assert.equal(strict.stdout.trim(), "");

	const ctl2 = runCtl(["send", session.id, "task again", "--wait", "--accept-partial"], agentDir);
	const cmd2 = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd2.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: cmd2.id });
	session.emit({ type: "agent_settled", owner: cmd2.id, foreignInputSeen: true, text: "mixed reply" });
	const partial = await ctl2;
	assert.equal(partial.code, 0);
	assert.equal(partial.stdout.trim(), "mixed reply");
	assert.match(partial.stderr, /concurrent user input/);
});

test("send --wait steer: unowned settle is weakly attributed with a warning", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "redirect", "--mode", "steer", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "steer", delivered: "steer", contended: true });
	session.emit({ type: "agent_settled", owner: null, foreignInputSeen: false, text: "steered outcome" });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.equal(result.stdout.trim(), "steered outcome");
	assert.match(result.stderr, /weak attribution/);
});

test("send --wait: steer-fallback delivery is surfaced on stderr", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "busy target", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "steer-fallback", contended: true });
	session.emit({ type: "turn_bound", id: cmd.id });
	session.emit({ type: "agent_settled", owner: cmd.id, foreignInputSeen: false, text: "late reply" });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.match(result.stderr, /delivered as steer/);
	assert.match(result.stderr, /contended/);
});

test("send --wait: silence hits the idle timeout, exit 2", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "void", "--wait", "--idle-timeout", "1"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	const result = await ctl;
	assert.equal(result.code, 2);
	assert.match(result.stderr, /No bridge activity/);
});

test("send --wait: bridge error record for this command exits 5", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "explode", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "error", id: cmd.id, error: "sendUserMessage failed" });
	const result = await ctl;
	assert.equal(result.code, 5);
	assert.match(result.stderr, /sendUserMessage failed/);
});

test("send --wait: workflow launch is followed to its completed notice", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "build it as a workflow", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	const runId = "11111111-2222-3333-4444-555555555555";
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: cmd.id });
	session.emit({ type: "workflow_started", runId, owner: cmd.id });
	session.emit({
		type: "agent_settled",
		owner: cmd.id,
		foreignInputSeen: false,
		text: `Workflow started: ${runId}`,
		provisional: true,
		pendingWork: [{ kind: "workflow", runId }],
	});
	session.emit({ type: "workflow_lifecycle", runId, kind: "completed", terminal: true, text: "workflow finished: 3 stages ok" });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.equal(result.stdout.trim(), "workflow finished: 3 stages ok");
	assert.doesNotMatch(result.stdout, /Workflow started/, "startup text must never be presented as the result");
});

test("send --wait: failed workflow exits 5", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "doomed workflow", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: cmd.id });
	session.emit({ type: "workflow_started", runId, owner: cmd.id });
	session.emit({ type: "workflow_lifecycle", runId, kind: "failed", terminal: true, text: "stage 2 blew up" });
	const result = await ctl;
	assert.equal(result.code, 5);
	assert.match(result.stderr, /failed/);
});

test("send --wait: idle timeout with a detached run still pending exits 7 with the run id", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "slow workflow", "--wait", "--idle-timeout", "1"], agentDir);
	const cmd = await session.nextInboxCommand();
	const runId = "99999999-8888-7777-6666-555555555555";
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "workflow_started", runId, owner: cmd.id });
	const result = await ctl;
	assert.equal(result.code, 7);
	assert.match(result.stderr, new RegExp(runId));
});

test("send --wait: outbox rotation mid-wait loses nothing", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "rotate under me", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: cmd.id });
	await sleep(700);
	session.rotateOutbox();
	session.emit({ type: "agent_settled", owner: cmd.id, foreignInputSeen: false, text: "survived rotation" });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.equal(result.stdout.trim(), "survived rotation");
});

test("send --wait: /reload inside the window reattaches and still resolves", async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(["send", session.id, "reload survivor", "--wait"], agentDir);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "turn_bound", id: cmd.id });
	session.emit({ type: "bridge_closed", reason: "reload", targetSessionFile: null });
	await sleep(600);
	session.emit({ type: "bridge_ready", id: session.id, protocol: 2 });
	session.emit({ type: "agent_settled", owner: cmd.id, foreignInputSeen: false, text: "back after reload" });
	const result = await ctl;
	assert.equal(result.code, 0);
	assert.equal(result.stdout.trim(), "back after reload");
	assert.match(result.stderr, /reattached/);
});

test("send --wait: a quit session with no reattach fails with exit 5 after the window", { timeout: 40_000 }, async () => {
	const { agentDir, session } = armedSession();
	const ctl = runCtl(
		["send", session.id, "goodbye", "--wait", "--idle-timeout", "35"],
		agentDir,
		{ timeoutMs: 35_000 },
	);
	const cmd = await session.nextInboxCommand();
	session.emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended: false });
	session.emit({ type: "bridge_closed", reason: "quit", targetSessionFile: null });
	const result = await ctl;
	assert.equal(result.code, 5);
	assert.match(result.stderr, /quit before replying/);
});
