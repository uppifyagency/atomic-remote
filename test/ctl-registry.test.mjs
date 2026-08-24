import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { makeAgentDir, makeSession, runCtl } from "./helpers.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

test("list: empty root prints setup hint, exit 0", async () => {
	const agentDir = makeAgentDir();
	const result = await runCtl(["list"], agentDir);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /No Atomic bridge sessions/);
	assert.match(result.stdout, /atomic-remote:setup/);
});

test("list: shows live and stale, hides closed unless --all", async () => {
	const agentDir = makeAgentDir();
	makeSession(agentDir, { id: "live-1", name: "alpha" });
	makeSession(agentDir, { id: "stale-1", name: "beta", heartbeat: "stale" });
	makeSession(agentDir, { id: "closed-1", name: "gamma", status: "closed" });

	const plain = await runCtl(["list"], agentDir);
	assert.equal(plain.code, 0);
	assert.match(plain.stdout, /live-1\s+live/);
	assert.match(plain.stdout, /stale-1\s+stale/);
	assert.doesNotMatch(plain.stdout, /closed-1/);

	const all = await runCtl(["list", "--all"], agentDir);
	assert.match(all.stdout, /closed-1\s+closed/);
});

test("list --json: parseable, carries state and dir", async () => {
	const agentDir = makeAgentDir();
	makeSession(agentDir, { id: "json-1", name: "alpha" });
	const result = await runCtl(["list", "--json"], agentDir);
	assert.equal(result.code, 0);
	const sessions = JSON.parse(result.stdout);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].state, "live");
	assert.equal(sessions[0].name, "alpha");
	assert.ok(sessions[0].dir.includes("json-1"));
});

test("list: live sessions show busy/idle from the heartbeat", async () => {
	const agentDir = makeAgentDir();
	const working = makeSession(agentDir, { id: "busy-1", name: "worker" });
	working.heartbeat({ busy: true });
	makeSession(agentDir, { id: "idle-1", name: "rester" });

	const result = await runCtl(["list"], agentDir);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /busy-1.*\bbusy\b/);
	assert.match(result.stdout, /idle-1.*\bidle\b/);

	const json = JSON.parse((await runCtl(["list", "--json"], agentDir)).stdout);
	assert.equal(json.find((s) => s.id === "busy-1").busy, true);
	assert.equal(json.find((s) => s.id === "idle-1").busy, false);
});

test("resolve: exact name beats cwd basename", async () => {
	const agentDir = makeAgentDir();
	const named = makeSession(agentDir, { id: "aa-name", name: "web", cwd: "/tmp/other" });
	makeSession(agentDir, { id: "bb-cwd", name: "elsewhere", cwd: "/tmp/web" });
	const result = await runCtl(["send", "web", "hello"], agentDir);
	assert.equal(result.code, 0);
	const commands = named.readInboxCommands();
	assert.equal(commands.length, 1);
	assert.equal(commands[0].message, "hello");
});

test("resolve: id prefix targets one session", async () => {
	const agentDir = makeAgentDir();
	const target = makeSession(agentDir, { id: "f00dcafe-1", name: "one" });
	makeSession(agentDir, { id: "beefcafe-2", name: "two" });
	const result = await runCtl(["send", "f00d", "ping it"], agentDir);
	assert.equal(result.code, 0);
	assert.equal(target.readInboxCommands().length, 1);
});

test("resolve: cwd basename works; ambiguous within a level exits 4 and lists candidates", async () => {
	const agentDir = makeAgentDir();
	makeSession(agentDir, { id: "amb-1", name: "one", cwd: "/a/proj" });
	makeSession(agentDir, { id: "amb-2", name: "two", cwd: "/b/proj" });
	const result = await runCtl(["send", "proj", "hello"], agentDir);
	assert.equal(result.code, 4);
	assert.match(result.stderr, /ambiguous/);
	assert.match(result.stderr, /amb-1/);
	assert.match(result.stderr, /amb-2/);
});

test("resolve: a single live match wins over a stale namesake", async () => {
	const agentDir = makeAgentDir();
	const live = makeSession(agentDir, { id: "ns-live", name: "dup" });
	makeSession(agentDir, { id: "ns-stale", name: "dup", heartbeat: "stale" });
	const result = await runCtl(["send", "dup", "hello"], agentDir);
	assert.equal(result.code, 0);
	assert.equal(live.readInboxCommands().length, 1);
});

test("resolve: auto with two live sessions exits 4; with one it delivers", async () => {
	const agentDir = makeAgentDir();
	const only = makeSession(agentDir, { id: "auto-1", name: "solo" });
	const ok = await runCtl(["send", "auto", "hi"], agentDir);
	assert.equal(ok.code, 0);
	assert.equal(only.readInboxCommands().length, 1);

	makeSession(agentDir, { id: "auto-2", name: "second" });
	const ambiguous = await runCtl(["send", "auto", "hi"], agentDir);
	assert.equal(ambiguous.code, 4);
	assert.match(ambiguous.stderr, /Multiple live sessions/);
});

test("resolve: no match among existing sessions exits 4, not 3", async () => {
	const agentDir = makeAgentDir();
	makeSession(agentDir, { id: "misses", name: "here" });
	const result = await runCtl(["send", "nomatch-xyz", "hi"], agentDir);
	assert.equal(result.code, 4);
	assert.doesNotMatch(result.stderr, /setup/);
});

test("resolve: no live sessions at all exits 3 with hint", async () => {
	const agentDir = makeAgentDir();
	const result = await runCtl(["send", "anything", "hi"], agentDir);
	assert.equal(result.code, 3);
	assert.match(result.stderr, /No live Atomic bridge sessions/);
});

test("send: refuses protocol < 2 with exit 5 and an upgrade hint", async () => {
	const agentDir = makeAgentDir();
	makeSession(agentDir, { id: "old-1", name: "old", protocol: 1 });
	const result = await runCtl(["send", "old", "hi"], agentDir);
	assert.equal(result.code, 5);
	assert.match(result.stderr, /protocol 1/);
	assert.match(result.stderr, /reload/);
});

test("send: a session whose heartbeat went stale is refused with exit 3 and a reload hint", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir, { id: "gone-1", name: "gone" });
	session.heartbeat({ ageMs: 60_000 });
	const result = await runCtl(["send", "gone-1", "hi"], agentDir);
	assert.equal(result.code, 3);
	assert.match(result.stderr, /stale/);
	assert.equal(session.readInboxCommands().length, 0, "nothing may be delivered to a stale session");
});

test("send: fire-and-forget writes one well-formed inbox command", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir, { id: "ff-1", name: "ff" });
	const result = await runCtl(["send", "ff", "run the tests", "--mode", "steer"], agentDir);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /Sent steer/);
	const [command] = session.readInboxCommands();
	assert.match(command.id, /^[A-Za-z0-9_-]{1,64}$/);
	assert.equal(command.action, "steer");
	assert.equal(command.message, "run the tests");
	assert.match(command.name, /^\d{14}-\d{3}-[A-Za-z0-9_-]+\.json$/);
});

test("send: stdin dash preserves multi-line text verbatim", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir, { id: "ml-1", name: "ml" });
	const text = "line one\n  indented two\n\nline four";
	const { runScript, CTL } = await import("./helpers.mjs");
	const result = await runScript(CTL, ["send", "ml", "-"], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir },
		stdin: text,
	});
	assert.equal(result.code, 0);
	assert.equal(session.readInboxCommands()[0].message, text);
});

test("tail: works on a closed session (history survives shutdown)", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir, { id: "hist-1", name: "hist", status: "closed" });
	session.emit({ type: "agent_settled", owner: null, text: "old reply" });
	const result = await runCtl(["tail", "hist-1"], agentDir);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /old reply/);
});

test("follow: bounded by default, replays history and exits 0", async () => {
	const agentDir = makeAgentDir();
	const session = makeSession(agentDir, { id: "fol-1", name: "fol", status: "closed" });
	session.emit({ type: "agent_start", owner: null });
	const result = await runCtl(["follow", "fol-1", "--for", "1"], agentDir);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /agent_start/);
});

test("flags: unknown flag is rejected, not forwarded into the prompt", async () => {
	const agentDir = makeAgentDir();
	makeSession(agentDir, { id: "fl-1", name: "fl" });
	const result = await runCtl(["send", "fl", "hi", "--timout", "5"], agentDir);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Unknown flag/);
});

test("flags: non-numeric value for a numeric flag is a usage error", async () => {
	const agentDir = makeAgentDir();
	const result = await runCtl(["follow", "x", "--for", "abc"], agentDir);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /requires a number/);
});

test("prune: removes only closed sessions past the cutoff, never live or stale", async () => {
	const agentDir = makeAgentDir();
	const live = makeSession(agentDir, {
		id: "pr-live",
		startedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
	});
	const stale = makeSession(agentDir, {
		id: "pr-stale",
		heartbeat: "stale",
		startedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
	});
	const oldClosed = makeSession(agentDir, {
		id: "pr-old",
		status: "closed",
		startedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
		closedAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
	});
	const result = await runCtl(["prune"], agentDir);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /Pruned 1 session dir/);
	assert.ok(fs.existsSync(live.dir), "live session must survive prune");
	assert.ok(fs.existsSync(stale.dir), "recently-seen stale session must survive prune");
	assert.ok(!fs.existsSync(oldClosed.dir), "old closed session should be pruned");
});

test("prune: a recently closed session survives even when it started long ago", async () => {
	const agentDir = makeAgentDir();
	const longLived = makeSession(agentDir, {
		id: "pr-recent",
		status: "closed",
		startedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
		closedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
	});
	const result = await runCtl(["prune"], agentDir);
	assert.equal(result.code, 0);
	assert.ok(fs.existsSync(longLived.dir), "session closed an hour ago must survive a 7-day prune");
});

test("prune: a long-dead stale session is reclaimed; a recently-seen one survives", async () => {
	const agentDir = makeAgentDir();
	const longDead = makeSession(agentDir, { id: "pr-dead", heartbeat: "none" });
	longDead.heartbeat({ ageMs: 10 * DAY_MS });
	const recentlySeen = makeSession(agentDir, { id: "pr-seen", heartbeat: "stale" });
	const noHeartbeatOld = makeSession(agentDir, {
		id: "pr-v1",
		heartbeat: "none",
		startedAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
	});
	const result = await runCtl(["prune"], agentDir);
	assert.equal(result.code, 0);
	assert.ok(!fs.existsSync(longDead.dir), "a session silent for 10 days should be reclaimed");
	assert.ok(fs.existsSync(recentlySeen.dir), "a session seen a minute ago must survive");
	assert.ok(!fs.existsSync(noHeartbeatOld.dir), "an old v1 session with no heartbeat should be reclaimed by startedAt");
});

test("prune: symlinked session dir pointing outside the root is skipped", async () => {
	const agentDir = makeAgentDir();
	const victim = makeSession(makeAgentDir(), { id: "outside", status: "closed" });
	const linkPath = path.join(agentDir, "remote-bridge", "outside");
	fs.symlinkSync(victim.dir, linkPath);
	const result = await runCtl(["prune", "--older-than", "0"], agentDir);
	assert.equal(result.code, 0);
	assert.ok(fs.existsSync(victim.dir), "prune must not follow symlinks outside the bridge root");
});
