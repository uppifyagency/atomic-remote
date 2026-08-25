#!/usr/bin/env node
/**
 * atomic-ctl v2 — Claude Code-side controller for the atomic-remote bridge.
 *
 * Usage:
 *   atomic-ctl.mjs list [--json] [--all]
 *   atomic-ctl.mjs ping <target>
 *   atomic-ctl.mjs status <target>
 *   atomic-ctl.mjs send <target> <message...> [--mode prompt|steer|follow_up|interrupt]
 *                  [--wait] [--idle-timeout <s>] [--timeout <s>] [--accept-partial]
 *                  [--message-file <path>]
 *   atomic-ctl.mjs tail <target> [--lines <n>]
 *   atomic-ctl.mjs follow <target> [--for <s>]
 *   atomic-ctl.mjs abort <target>
 *   atomic-ctl.mjs prune [--older-than <days>]
 *
 * <target>: bridge name, session-id prefix, cwd (exact path or basename), or
 * "auto" (allowed only when exactly one live session exists).
 *
 * Exit codes:
 *   0 completed   2 idle/absolute timeout   3 no session recorded / delivery refused
 *   4 target not found or ambiguous        5 bridge or run error
 *   6 attribution uncertain (concurrent user input)
 *   7 detached async work still running (workflow run id printed)
 *   1 usage error
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXPECTED_PROTOCOL = 2; // delivery floor: v2 sessions still take v2-shaped commands
const V3_PROTOCOL = 3; // required for plan/command/run_workflow
const MAX_PLAN_BYTES = 8 * 1024;
const MAX_WORKFLOW_SOURCE_BYTES = 200 * 1024; // leaves headroom under the bridge's 256 KiB command cap
const HEARTBEAT_STALE_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_S = 120;
const POLL_MS = 250;
const PRUNE_DEFAULT_DAYS = 7;
const REATTACH_WINDOW_MS = 20_000; // grace for bridge_ready after bridge_closed (/reload, /new)
const DEFAULT_FOLLOW_S = 30; // follow is bounded by default; --for 0 streams forever
const QUICK_TIMEOUT_S = 10; // ping/status round-trips

const agentDir = process.env.ATOMIC_CODING_AGENT_DIR ?? path.join(os.homedir(), ".atomic", "agent");
const bridgeRoot = path.join(agentDir, "remote-bridge");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, code = 1) {
	console.error(message);
	process.exit(code);
}

// --- session registry (read-only: list NEVER deletes) ----------------------

function readHeartbeat(dir) {
	try {
		const hb = JSON.parse(fs.readFileSync(path.join(dir, "heartbeat.json"), "utf8"));
		return { state: Date.now() - Number(hb.ts) < HEARTBEAT_STALE_MS ? "live" : "stale", busy: hb.busy === true };
	} catch {
		return { state: "stale", busy: null };
	}
}

function listSessions() {
	if (!fs.existsSync(bridgeRoot)) return [];
	const sessions = [];
	for (const entry of fs.readdirSync(bridgeRoot)) {
		const dir = path.join(bridgeRoot, entry);
		let meta;
		try {
			meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
		} catch {
			continue;
		}
		const hb = meta.status === "closed" ? { state: "closed", busy: null } : readHeartbeat(dir);
		sessions.push({ ...meta, dir, state: hb.state, busy: hb.state === "live" ? hb.busy : null });
	}
	return sessions.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
}

function formatSessions(sessions) {
	return sessions
		.map(
			(s) =>
				`  ${String(s.id).slice(0, 12).padEnd(13)} ${s.state.padEnd(7)} ${(s.state === "live" ? (s.busy ? "busy" : "idle") : "-").padEnd(5)} name=${s.name ?? "-"}  cwd=${s.cwd}  proto=${s.protocol ?? 1}  started=${s.startedAt ?? "?"}`,
		)
		.join("\n");
}

// anyState: read-only commands (tail/follow) may target stale/closed sessions —
// history survives shutdown and must stay reachable. Delivery commands stay live-only.
function resolveTarget(token, { anyState = false } = {}) {
	const all = listSessions();
	const live = all.filter((s) => s.state === "live");
	const pool = anyState ? all : live;
	if (pool.length === 0) {
		if (anyState) fail("No Atomic bridge sessions recorded.", 3);
		const hint = all.some((s) => s.state === "stale")
			? "Sessions exist but their heartbeat is stale — the bridge may be v1 (rerun setup + /reload in Atomic) or the session hung."
			: "Install the bridge (/atomic-remote:setup), then run /reload inside the Atomic session.";
		fail(`No live Atomic bridge sessions found.\n${hint}`, 3);
	}
	if (!token || token === "auto") {
		if (live.length === 1) return live[0];
		if (anyState && live.length === 0 && pool.length === 1) return pool[0];
		fail(`Multiple ${anyState ? "" : "live "}sessions — specify a target:\n${formatSessions(pool)}`, 4);
	}
	const lower = token.toLowerCase();
	// Precedence levels; ambiguity is only an error within the same level.
	const levels = [
		(s) => typeof s.name === "string" && s.name.toLowerCase() === lower,
		(s) => String(s.id).startsWith(token),
		(s) => String(s.cwd) === token || String(s.cwd).toLowerCase() === lower,
		(s) => path.basename(String(s.cwd)).toLowerCase() === lower,
		(s) => String(s.cwd).toLowerCase().endsWith(lower),
	];
	for (const predicate of levels) {
		const matches = pool.filter(predicate);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			// Prefer the single live match over stale/closed namesakes.
			const liveMatches = matches.filter((s) => s.state === "live");
			if (liveMatches.length === 1) return liveMatches[0];
			fail(`"${token}" is ambiguous:\n${formatSessions(matches)}`, 4);
		}
	}
	// Exit 4, not 3: sessions exist, the token just matched none of them —
	// the remedy is fixing the target, not reinstalling the bridge.
	fail(`No ${anyState ? "" : "live "}session matches "${token}". Sessions:\n${formatSessions(pool)}`, 4);
}

// --- outbox reader: stateful, rewind-safe (roadmap #5) ----------------------

function makeOutboxReader(outbox) {
	const state = { ino: null, offset: 0, seen: new Set() };

	function readRange(file, from, to) {
		if (to <= from) return null;
		const buffer = Buffer.alloc(Number(to - from));
		let fd;
		try {
			fd = fs.openSync(file, "r");
			fs.readSync(fd, buffer, 0, buffer.length, from);
			return buffer;
		} catch {
			return null;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	return function readNew() {
		let stat;
		try {
			stat = fs.statSync(outbox);
		} catch {
			return [];
		}
		const chunks = [];
		if (state.ino !== null && stat.ino !== state.ino) {
			// The bridge rotates by renaming outbox.jsonl → outbox.1.jsonl and starting
			// fresh. Drain the tail of the renamed file (same inode we were reading)
			// before switching, so nothing written between polls is lost.
			try {
				const rotated = `${outbox.replace(/\.jsonl$/, "")}.1.jsonl`;
				const rstat = fs.statSync(rotated);
				if (rstat.ino === state.ino) {
					const tail = readRange(rotated, state.offset, rstat.size);
					if (tail) chunks.push(tail);
				}
			} catch {
				// Rotated file gone (pruned): dedupe below is the only safety net left.
			}
			state.offset = 0;
		} else if (stat.size < state.offset) {
			state.offset = 0; // truncated: rescan, dedupe below
		}
		state.ino = stat.ino;
		if (stat.size > state.offset) {
			const fresh = readRange(outbox, state.offset, stat.size);
			if (fresh) {
				const lastNewline = fresh.lastIndexOf(0x0a);
				if (lastNewline !== -1) {
					state.offset += lastNewline + 1;
					chunks.push(fresh.subarray(0, lastNewline + 1));
				}
			}
		}
		if (chunks.length === 0) return [];
		// Dedupe only matters across rotation/truncation rescans; a bounded set is fine.
		if (state.seen.size > 20_000) state.seen.clear();
		const items = [];
		for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let record;
			try {
				record = JSON.parse(trimmed);
			} catch {
				continue;
			}
			const key = `${record.type}|${record.id ?? ""}|${record.runId ?? ""}|${record.kind ?? ""}|${record.ts ?? ""}`;
			if (state.seen.has(key)) continue;
			state.seen.add(key);
			items.push(record);
		}
		return items;
	};
}

// --- command transport (roadmap #1: refuse delivery to the dead) ------------

let commandSeq = 0;

function writeCommand(target, payload) {
	if ((target.protocol ?? 1) < EXPECTED_PROTOCOL) {
		fail(
			`Bridge protocol ${target.protocol ?? 1} < ${EXPECTED_PROTOCOL} in session ${target.id}.\nUpdate it: /atomic-remote:setup, then /reload inside Atomic.`,
			5,
		);
	}
	if (readHeartbeat(target.dir).state !== "live") {
		fail(`Session ${target.id} stopped responding (stale heartbeat) — command not delivered.`, 3);
	}
	const inbox = path.join(target.dir, "inbox");
	const tmpDir = path.join(inbox, ".tmp");
	fs.mkdirSync(tmpDir, { recursive: true });
	const name = `${String(Date.now()).padStart(14, "0")}-${String(commandSeq++).padStart(3, "0")}-${payload.id}.json`;
	const tmp = path.join(tmpDir, name);
	fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
	fs.renameSync(tmp, path.join(inbox, name));
}

// --- outcome tracker: one reducer for live waits and post-hoc queries --------
// The wait loop and the `outcome` command classify through this same state
// machine, so a --wait that exited 2 and a later `outcome` cannot disagree.

function createOutcomeTracker(payload, flags) {
	const isPrompt = ["prompt", "interrupt", "command", "run_workflow"].includes(payload.action);
	const st = {
		accepted: false,
		bound: false,
		foreignSeen: false,
		planPath: null,
		workflowName: null,
		myRuns: new Set(),
		runDetail: new Map(), // runId -> last workflow_lifecycle record
		resolved: null, // { text }
		failure: null, // { state, code, message, runId?, failedStageId? }
	};

	// Directives for a live loop: {op:"note"|"resolve"|"fail", ...}. A post-hoc
	// replay ignores them and reads snapshot() instead.
	function apply(record) {
		const out = [];
		switch (record.type) {
			case "error":
				if (record.id === payload.id) {
					st.failure = { state: "failed", code: 5, message: `Bridge error: ${record.error}` };
					out.push({ op: "fail", code: 5, message: st.failure.message });
				}
				break;
			case "accepted":
				if (record.id === payload.id) {
					st.accepted = true;
					if (record.planPath) st.planPath = record.planPath;
					if (record.workflowName) st.workflowName = record.workflowName;
					if (record.delivered === "steer-fallback") out.push({ op: "note", message: "note: agent busy — delivered as steer" });
					if (record.contended)
						out.push({ op: "note", message: "note: session is busy (contended) — attribution may be unreliable" });
				}
				break;
			case "workflow_installed":
				if (record.id === payload.id && record.overwrote)
					out.push({ op: "note", message: `note: overwrote existing workflow at ${record.targetPath}` });
				break;
			case "turn_bound":
				if (record.id === payload.id) st.bound = true;
				break;
			case "foreign_input":
				if (st.accepted && !st.bound) {
					st.foreignSeen = true;
					if (isPrompt && !flags.acceptPartial) {
						st.failure = {
							state: "uncertain",
							code: 6,
							message: "Attribution abandoned: concurrent user input in the Atomic session.",
						};
						out.push({ op: "fail", code: 6, message: `${st.failure.message}\nInspect manually: tail <target>` });
					}
				}
				break;
			case "workflow_started":
				if (record.owner === payload.id) {
					st.myRuns.add(record.runId);
					out.push({ op: "note", message: `note: workflow launched (${record.runId}) — waiting for its terminal notice` });
				}
				break;
			case "workflow_lifecycle":
				if (st.myRuns.has(record.runId)) {
					st.runDetail.set(record.runId, record);
					if (record.terminal) {
						if (record.kind === "completed") {
							st.resolved = { text: record.text ?? `workflow ${record.runId} completed` };
							out.push({ op: "resolve", text: st.resolved.text });
						} else {
							st.failure = {
								state: "failed",
								code: 5,
								message: `Workflow ${record.runId} ended: ${record.kind}\n${record.text ?? ""}`,
								runId: record.runId,
								failedStageId: record.failedStageId ?? null,
							};
							out.push({ op: "fail", code: 5, message: st.failure.message });
						}
					}
				}
				break;
			case "agent_settled": {
				if (!st.accepted) break;
				const owned = record.owner === payload.id;
				const weaklyOwned =
					record.owner === null && !st.bound && !isPrompt && !st.foreignSeen && !record.foreignInputSeen;
				if (!owned && !weaklyOwned) break;
				if (owned && record.aborted) {
					st.failure = {
						state: "aborted",
						code: 5,
						message: "The turn for this command was aborted before completing (interrupted).",
					};
					out.push({ op: "fail", code: 5, message: st.failure.message });
					break;
				}
				if (owned && record.foreignInputSeen && isPrompt && !flags.acceptPartial) {
					st.failure = {
						state: "uncertain",
						code: 6,
						message: "Attribution uncertain: the user typed into the Atomic session during your turn.",
					};
					out.push({ op: "fail", code: 6, message: `${st.failure.message}\nInspect manually: tail <target>` });
					break;
				}
				if (record.provisional && st.myRuns.size > 0) break; // workflow still running
				if (record.provisional && Array.isArray(record.pendingWork)) {
					for (const work of record.pendingWork) if (work.runId) st.myRuns.add(work.runId);
					out.push({ op: "note", message: "note: turn settled with detached async work — waiting for workflow completion" });
					break;
				}
				if (owned && record.foreignInputSeen)
					out.push({ op: "note", message: "note: concurrent user input during the turn — reply may reflect it (--accept-partial)" });
				if (weaklyOwned) out.push({ op: "note", message: "note: weak attribution (steer/follow_up binding is best-effort)" });
				st.resolved = { text: record.text ?? "(agent settled with no assistant text)" };
				out.push({ op: "resolve", text: st.resolved.text });
				break;
			}
			default:
				break;
		}
		return out;
	}

	function snapshot() {
		const pendingRuns = [...st.myRuns].filter((runId) => !st.runDetail.get(runId)?.terminal);
		const base = {
			commandId: payload.id,
			action: payload.action,
			...(st.planPath ? { planPath: st.planPath } : {}),
			...(st.workflowName ? { workflowName: st.workflowName } : {}),
			runs: [...st.myRuns].map((runId) => {
				const detail = st.runDetail.get(runId);
				return {
					runId,
					kind: detail?.kind ?? "started",
					terminal: detail?.terminal ?? false,
					...(detail?.failedStageId ? { failedStageId: detail.failedStageId } : {}),
					...(detail?.stageName ? { stageName: detail.stageName } : {}),
				};
			}),
		};
		if (st.failure) {
			const { state, code, message, runId, failedStageId } = st.failure;
			return {
				...base,
				state,
				exitCode: code,
				text: message,
				...(runId ? { runId } : {}),
				...(failedStageId ? { failedStageId } : {}),
			};
		}
		if (st.resolved) return { ...base, state: "completed", exitCode: 0, text: st.resolved.text };
		if (!st.accepted) return { ...base, state: "pending", exitCode: 2 };
		if (pendingRuns.length > 0) return { ...base, state: "detached", exitCode: 7, runId: pendingRuns[0] };
		return { ...base, state: "working", exitCode: 2 };
	}

	return { apply, snapshot, state: st };
}

// --- wait loop (roadmap #2, #3, #5) -----------------------------------------

async function waitForOutcome(target, payload, flags) {
	const outbox = path.join(target.dir, "outbox.jsonl");
	const readNew = makeOutboxReader(outbox);
	readNew(); // consume history up to now
	writeCommand(target, payload);

	const startedAt = Date.now();
	let lastActivityAt = Date.now();
	let reattachDeadline = null; // set while waiting for bridge_ready after bridge_closed
	let closeReason = null;
	const tracker = createOutcomeTracker(payload, flags);
	const finish = (code) => {
		if (flags.json) console.log(JSON.stringify(tracker.snapshot(), null, 2));
		return code;
	};

	for (;;) {
		await sleep(POLL_MS);
		const records = readNew();
		if (records.length > 0) lastActivityAt = Date.now();
		for (const record of records) {
			if (flags.verbose) console.error(`[${record.type}]${record.id ? ` id=${record.id}` : ""}`);
			// Round-trip commands resolve outside the outcome state machine.
			if (record.type === "pong" && record.id === payload.id) {
				if ((record.protocol ?? 1) < EXPECTED_PROTOCOL)
					console.error(`warning: bridge protocol ${record.protocol ?? 1} — rerun setup + /reload`);
				console.log("pong");
				return 0;
			}
			if (record.type === "status_report" && record.id === payload.id) {
				console.log(JSON.stringify(record, null, 2));
				return 0;
			}
			if (record.type === "accepted" && record.id === payload.id && payload.action === "abort") {
				console.log("abort delivered");
				return 0;
			}
			if (record.type === "bridge_ready") {
				if (reattachDeadline !== null) {
					console.error(`note: session ${closeReason === "reload" ? "reloaded" : "replaced"} — reattached`);
					reattachDeadline = null;
					closeReason = null;
				}
				continue;
			}
			if (record.type === "bridge_closed") {
				// Don't fail yet: /reload and /new re-arm the same bridge directory.
				// Keep processing records (a settle may already be in the outbox) and
				// give bridge_ready a bounded window to show up.
				reattachDeadline = Date.now() + REATTACH_WINDOW_MS;
				closeReason = record.reason ?? "quit";
				continue;
			}
			for (const directive of tracker.apply(record)) {
				if (directive.op === "note") console.error(directive.message);
				else if (directive.op === "resolve") {
					if (flags.json) return finish(0);
					console.log(directive.text);
					return 0;
				} else if (directive.op === "fail") {
					if (flags.json) {
						console.error(directive.message.replace("tail <target>", `tail ${target.id.slice(0, 8)}`));
						process.exit(finish(directive.code));
					}
					fail(directive.message.replace("tail <target>", `tail ${target.id.slice(0, 8)}`), directive.code);
				}
			}
		}
		if (reattachDeadline !== null && Date.now() > reattachDeadline) {
			if (flags.json) process.exit(finish(5));
			fail(
				closeReason === "quit"
					? "The Atomic session quit before replying."
					: `The Atomic session was ${closeReason}ed; the command may be lost. Check: tail ${target.id.slice(0, 8)}`,
				5,
			);
		}
		const idleMs = Date.now() - lastActivityAt;
		const totalMs = Date.now() - startedAt;
		const myRuns = tracker.state.myRuns;
		if (flags.timeoutS > 0 && totalMs > flags.timeoutS * 1000) {
			if (flags.json) process.exit(finish(myRuns.size > 0 ? 7 : 2));
			if (myRuns.size > 0) fail(`Absolute timeout; workflow still running: ${[...myRuns].join(", ")}`, 7);
			fail(`Absolute timeout after ${flags.timeoutS}s — check later: tail ${target.id.slice(0, 8)}`, 2);
		}
		if (idleMs > flags.idleTimeoutS * 1000) {
			if (flags.json) process.exit(finish(myRuns.size > 0 ? 7 : 2));
			if (myRuns.size > 0)
				fail(
					`No bridge activity for ${flags.idleTimeoutS}s; detached workflow still running: ${[...myRuns].join(", ")}`,
					7,
				);
			fail(
				`No bridge activity for ${flags.idleTimeoutS}s — the session may be stuck or quietly working without events. Check: tail ${target.id.slice(0, 8)}`,
				2,
			);
		}
	}
}

// --- flags -------------------------------------------------------------------

const FLAG_SPECS = {
	"--mode": { key: "mode", takesValue: true },
	"--wait": { key: "wait", takesValue: false },
	"--idle-timeout": { key: "idleTimeoutS", takesValue: true, numeric: true },
	"--timeout": { key: "timeoutS", takesValue: true, numeric: true },
	"--accept-partial": { key: "acceptPartial", takesValue: false },
	"--message-file": { key: "messageFile", takesValue: true },
	"--plan": { key: "planFile", takesValue: true },
	"--name": { key: "workflowName", takesValue: true },
	"--args": { key: "workflowArgs", takesValue: true },
	"--lines": { key: "lines", takesValue: true, numeric: true },
	"--for": { key: "forS", takesValue: true, numeric: true },
	"--older-than": { key: "olderThanDays", takesValue: true, numeric: true },
	"--json": { key: "json", takesValue: false },
	"--all": { key: "all", takesValue: false },
	"--verbose": { key: "verbose", takesValue: false },
	"-v": { key: "verbose", takesValue: false },
};

function parseArgs(args) {
	const rest = [];
	const flags = {
		mode: "prompt",
		wait: false,
		idleTimeoutS: DEFAULT_IDLE_TIMEOUT_S,
		timeoutS: 0,
		acceptPartial: false,
		messageFile: null,
		planFile: null,
		workflowName: null,
		workflowArgs: null,
		lines: 20,
		forS: null, // null = command default (DEFAULT_FOLLOW_S); 0 = unbounded
		olderThanDays: PRUNE_DEFAULT_DAYS,
		json: false,
		all: false,
		verbose: false,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("-") && arg !== "-") {
			const spec = FLAG_SPECS[arg];
			if (!spec) fail(`Unknown flag: ${arg} (it will NOT be forwarded to Atomic). See --help.`);
			if (spec.takesValue) {
				const value = args[++i];
				if (value === undefined) fail(`Flag ${arg} requires a value`);
				flags[spec.key] = spec.numeric ? Number(value) : value;
				if (spec.numeric && !Number.isFinite(flags[spec.key])) fail(`Flag ${arg} requires a number`);
			} else {
				flags[spec.key] = true;
			}
		} else {
			rest.push(arg);
		}
	}
	if (!["prompt", "steer", "follow_up", "interrupt", "command"].includes(flags.mode)) {
		fail(`Invalid --mode: ${flags.mode} (use prompt|steer|follow_up|interrupt|command)`);
	}
	return { rest, flags };
}

function newCommandId() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

// --- main ---------------------------------------------------------------------

const USAGE = `atomic-ctl v2 — command running Atomic sessions via the atomic-remote bridge

Commands:
  list [--json] [--all]        Show sessions (live/stale; --all includes closed)
  ping <target>                Round-trip liveness + protocol check
  status <target>              Ask the bridge for idle/busy, pending workflows
  send <target> <message...>   Inject a command; message "-" reads stdin
       [--mode prompt|steer|follow_up|interrupt|command] [--wait] [--json]
       [--plan <plan.json>] [--idle-timeout <s>=120] [--timeout <s>]
       [--accept-partial] [--message-file <path>] [-v]
       --plan attaches a structured plan artifact (prompt/follow_up, proto 3)
       --mode command dispatches a leading-slash message as a real slash command
  run-workflow <target> <file.ts> [--name <n>] [--args "<a>"] [--wait] [--json]
       Install the workflow into the session's .atomic/workflows/, reload,
       and run it deterministically (proto 3)
  outcome <target> <command-id> [--json]
       Query a past command's result from outbox history (safe to poll;
       works on closed sessions): state pending|working|completed|failed|
       aborted|uncertain|detached, text, runs, failedStageId
  tail <target> [--lines <n>]  Print recent outbox records (works on closed sessions)
  follow <target> [--for <s>]  Stream outbox records (default 30s; --for 0 = forever)
  abort <target>               Abort the session's current turn
  prune [--older-than <days>]  Delete closed/long-stale session dirs (never live ones)

Exit codes: 0 ok · 1 usage · 2 timeout · 3 no session recorded/delivery refused
            4 target not found or ambiguous · 5 bridge/run error
            6 attribution uncertain · 7 async work detached`;

async function main() {
	const [command, ...argv] = process.argv.slice(2);
	const { rest, flags } = parseArgs(argv);

	switch (command) {
		case "list": {
			const sessions = listSessions().filter((s) => flags.all || s.state !== "closed");
			if (flags.json) {
				console.log(JSON.stringify(sessions, null, 2));
				return;
			}
			if (sessions.length === 0) {
				console.log("No Atomic bridge sessions.");
				console.log("Install the bridge (/atomic-remote:setup), then /reload inside the Atomic session.");
				return;
			}
			console.log(formatSessions(sessions));
			return;
		}
		case "ping":
		case "status":
		case "abort": {
			const target = resolveTarget(rest[0]);
			// Snappy defaults for round-trips, but an explicit --timeout/--idle-timeout wins.
			const quickS = command === "abort" ? 15 : QUICK_TIMEOUT_S;
			process.exit(
				await waitForOutcome(
					target,
					{ id: newCommandId(), action: command },
					{
						...flags,
						idleTimeoutS: flags.idleTimeoutS !== DEFAULT_IDLE_TIMEOUT_S ? flags.idleTimeoutS : quickS,
						timeoutS: flags.timeoutS > 0 ? flags.timeoutS : quickS,
					},
				),
			);
			break;
		}
		case "send": {
			const [token, ...messageParts] = rest;
			let message;
			if (flags.messageFile) {
				message = fs.readFileSync(flags.messageFile, "utf8");
			} else if (messageParts.length === 1 && messageParts[0] === "-") {
				message = fs.readFileSync(0, "utf8");
			} else {
				// join(" ") would collapse newlines typed via $'...' args; single-arg messages pass through verbatim.
				message = messageParts.length === 1 ? messageParts[0] : messageParts.join(" ");
			}
			if (!message || message.trim().length === 0) {
				fail('Usage: send <target|auto> <message...> (or --message-file <path>, or "-" for stdin)');
			}
			if (flags.mode === "command" && !message.trim().startsWith("/")) {
				fail("--mode command requires a message starting with / (a slash command)");
			}
			let plan = null;
			if (flags.planFile) {
				if (!["prompt", "follow_up"].includes(flags.mode)) fail("--plan is only allowed with --mode prompt|follow_up");
				let parsed;
				try {
					parsed = JSON.parse(fs.readFileSync(flags.planFile, "utf8"));
				} catch (error) {
					fail(`--plan ${flags.planFile}: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("--plan must be a JSON object");
				if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_PLAN_BYTES) fail(`--plan exceeds ${MAX_PLAN_BYTES} bytes`);
				plan = parsed;
			}
			const target = resolveTarget(token);
			// v3-only features are refused client-side, before anything reaches the
			// inbox: a v2 bridge rejects unknown keys with a confusing error from
			// the other side, and a silently degraded plan handoff is the lossy
			// handoff this protocol exists to eliminate.
			if ((plan || flags.mode === "command") && (target.protocol ?? 1) < V3_PROTOCOL) {
				fail(
					`${plan ? "--plan" : "--mode command"} requires bridge protocol ${V3_PROTOCOL} (session runs ${target.protocol ?? 1}).\nUpdate it: /atomic-remote:setup, then /reload inside Atomic.`,
					5,
				);
			}
			const payload = { id: newCommandId(), action: flags.mode, message, ...(plan ? { plan } : {}) };
			if (!flags.wait) {
				writeCommand(target, payload);
				console.log(`Sent ${flags.mode} to ${target.name ?? target.id} (command id ${payload.id}).`);
				console.log(`Follow with: follow ${String(target.id).slice(0, 8)} · or read later: tail ${String(target.id).slice(0, 8)}`);
				return;
			}
			process.exit(await waitForOutcome(target, payload, flags));
			break;
		}
		case "run-workflow": {
			const [token, workflowFile] = rest;
			if (!workflowFile) fail('Usage: run-workflow <target|auto> <file.ts> [--name <name>] [--args "<args>"] [--wait]');
			let workflowSource;
			try {
				workflowSource = fs.readFileSync(workflowFile, "utf8");
			} catch (error) {
				fail(`run-workflow: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (Buffer.byteLength(workflowSource) > MAX_WORKFLOW_SOURCE_BYTES) {
				fail(`run-workflow: source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`);
			}
			const workflowName = flags.workflowName ?? path.basename(workflowFile).replace(/\.(ts|js|mjs|cjs)$/, "");
			if (!/^[a-z0-9-]{1,64}$/.test(workflowName)) {
				fail(`run-workflow: invalid workflow name "${workflowName}" (use [a-z0-9-]{1,64}, or pass --name)`);
			}
			const target = resolveTarget(token);
			if ((target.protocol ?? 1) < V3_PROTOCOL) {
				fail(
					`run-workflow requires bridge protocol ${V3_PROTOCOL} (session runs ${target.protocol ?? 1}).\nUpdate it: /atomic-remote:setup, then /reload inside Atomic.`,
					5,
				);
			}
			const payload = {
				id: newCommandId(),
				action: "run_workflow",
				workflowName,
				workflowSource,
				...(flags.workflowArgs ? { args: flags.workflowArgs } : {}),
			};
			if (!flags.wait) {
				writeCommand(target, payload);
				console.log(`Sent run_workflow ${workflowName} to ${target.name ?? target.id} (command id ${payload.id}).`);
				console.log(`Follow with: follow ${String(target.id).slice(0, 8)} · or query later: outcome ${String(target.id).slice(0, 8)} ${payload.id}`);
				return;
			}
			process.exit(await waitForOutcome(target, payload, flags));
			break;
		}
		case "outcome": {
			const [token, commandId] = rest;
			if (!commandId) fail("Usage: outcome <target> <command-id> [--json]");
			const target = resolveTarget(token, { anyState: true });
			// Post-hoc: replay the full history (rotated file first) through the
			// same reducer the wait loop uses, then read its verdict.
			const tracker = createOutcomeTracker({ id: commandId, action: "prompt" }, flags);
			let seen = false;
			for (const file of [path.join(target.dir, "outbox.1.jsonl"), path.join(target.dir, "outbox.jsonl")]) {
				let content;
				try {
					content = fs.readFileSync(file, "utf8");
				} catch {
					continue;
				}
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					let record;
					try {
						record = JSON.parse(trimmed);
					} catch {
						continue;
					}
					if (record.id === commandId || record.owner === commandId) seen = true;
					tracker.apply(record);
				}
			}
			if (!seen) fail(`No outbox record mentions command ${commandId} in session ${target.id}.`, 4);
			const outcome = tracker.snapshot();
			console.log(JSON.stringify(outcome, null, 2));
			return;
		}
		case "tail": {
			const target = resolveTarget(rest[0], { anyState: true });
			const outbox = path.join(target.dir, "outbox.jsonl");
			if (!fs.existsSync(outbox)) {
				console.log("(outbox empty)");
				return;
			}
			const lines = fs.readFileSync(outbox, "utf8").trimEnd().split("\n");
			console.log(lines.slice(-flags.lines).join("\n"));
			return;
		}
		case "follow": {
			const target = resolveTarget(rest[0], { anyState: true });
			const readNew = makeOutboxReader(path.join(target.dir, "outbox.jsonl"));
			// Bounded by default so scripted callers always get their terminal back;
			// --for 0 opts into an unbounded stream.
			const forS = flags.forS === null ? DEFAULT_FOLLOW_S : flags.forS;
			const until = forS > 0 ? Date.now() + forS * 1000 : Number.POSITIVE_INFINITY;
			for (const record of readNew()) console.log(JSON.stringify(record));
			while (Date.now() < until) {
				await sleep(POLL_MS);
				for (const record of readNew()) console.log(JSON.stringify(record));
			}
			return;
		}
		case "prune": {
			const cutoff = Date.now() - flags.olderThanDays * 24 * 60 * 60 * 1000;
			const realRoot = fs.existsSync(bridgeRoot) ? fs.realpathSync(bridgeRoot) : null;
			if (!realRoot) {
				console.log("Nothing to prune.");
				return;
			}
			let removed = 0;
			for (const session of listSessions()) {
				if (session.state === "live") continue;
				// Age from the last sign of life, not from startedAt: a long-lived session
				// closed an hour ago is not "old". Crashed and v1 sessions never reach
				// status "closed", so stale ones age by their last heartbeat instead of
				// leaking forever.
				let lastSeen;
				if (session.state === "closed") {
					lastSeen = Date.parse(String(session.closedAt ?? session.startedAt ?? "")) || 0;
				} else {
					try {
						lastSeen = Number(JSON.parse(fs.readFileSync(path.join(session.dir, "heartbeat.json"), "utf8")).ts) || 0;
					} catch {
						lastSeen = Date.parse(String(session.startedAt ?? "")) || 0;
					}
				}
				if (lastSeen > cutoff) continue;
				const real = fs.realpathSync(session.dir);
				if (path.relative(realRoot, real).startsWith("..")) continue; // symlink escape guard
				fs.rmSync(session.dir, { recursive: true, force: true });
				removed++;
			}
			console.log(`Pruned ${removed} session dir(s) (closed or long-stale).`);
			return;
		}
		case "--help":
		case "help":
		case undefined:
			console.log(USAGE);
			return;
		default:
			fail(USAGE);
	}
}

main().catch((error) => fail(String(error), 5));
