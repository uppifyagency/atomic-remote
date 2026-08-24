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
 *   0 completed   2 idle/absolute timeout   3 no live session   4 ambiguous target
 *   5 bridge or run error                   6 attribution uncertain (concurrent user input)
 *   7 detached async work still running (workflow run id printed)
 *   1 usage error
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXPECTED_PROTOCOL = 2;
const HEARTBEAT_STALE_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_S = 120;
const POLL_MS = 250;
const PRUNE_DEFAULT_DAYS = 7;

const agentDir = process.env.ATOMIC_CODING_AGENT_DIR ?? path.join(os.homedir(), ".atomic", "agent");
const bridgeRoot = path.join(agentDir, "remote-bridge");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, code = 1) {
	console.error(message);
	process.exit(code);
}

// --- session registry (read-only: list NEVER deletes) ----------------------

function heartbeatState(dir) {
	try {
		const hb = JSON.parse(fs.readFileSync(path.join(dir, "heartbeat.json"), "utf8"));
		return Date.now() - Number(hb.ts) < HEARTBEAT_STALE_MS ? "live" : "stale";
	} catch {
		return "stale";
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
		const state = meta.status === "closed" ? "closed" : heartbeatState(dir);
		sessions.push({ ...meta, dir, state });
	}
	return sessions.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
}

function formatSessions(sessions) {
	return sessions
		.map(
			(s) =>
				`  ${String(s.id).slice(0, 12).padEnd(13)} ${s.state.padEnd(7)} name=${s.name ?? "-"}  cwd=${s.cwd}  proto=${s.protocol ?? 1}  started=${s.startedAt ?? "?"}`,
		)
		.join("\n");
}

function resolveTarget(token) {
	const all = listSessions();
	const live = all.filter((s) => s.state === "live");
	if (live.length === 0) {
		const hint = all.some((s) => s.state === "stale")
			? "Sessions exist but their heartbeat is stale — the bridge may be v1 (rerun setup + /reload in Atomic) or the session hung."
			: "Install the bridge (/atomic-remote:setup), then run /reload inside the Atomic session.";
		fail(`No live Atomic bridge sessions found.\n${hint}`, 3);
	}
	if (!token || token === "auto") {
		if (live.length === 1) return live[0];
		fail(`Multiple live sessions — specify a target:\n${formatSessions(live)}`, 4);
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
		const matches = live.filter(predicate);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) fail(`"${token}" is ambiguous:\n${formatSessions(matches)}`, 4);
	}
	fail(`No live session matches "${token}". Live sessions:\n${formatSessions(live)}`, 3);
}

// --- outbox reader: stateful, rewind-safe (roadmap #5) ----------------------

function makeOutboxReader(outbox) {
	const state = { ino: null, offset: 0, seen: new Set() };
	return function readNew() {
		let stat;
		try {
			stat = fs.statSync(outbox);
		} catch {
			return [];
		}
		if (state.ino !== null && (stat.ino !== state.ino || stat.size < state.offset)) {
			state.offset = 0; // rotated or truncated: rescan, dedupe below
		}
		state.ino = stat.ino;
		if (stat.size <= state.offset) return [];
		const length = stat.size - state.offset;
		const buffer = Buffer.alloc(Number(length));
		let fd;
		try {
			fd = fs.openSync(outbox, "r");
			fs.readSync(fd, buffer, 0, buffer.length, state.offset);
		} catch {
			return [];
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
		const lastNewline = buffer.lastIndexOf(0x0a);
		if (lastNewline === -1) return [];
		state.offset += lastNewline + 1;
		const items = [];
		for (const line of buffer.subarray(0, lastNewline + 1).toString("utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let record;
			try {
				record = JSON.parse(trimmed);
			} catch {
				continue;
			}
			const key = `${record.type}|${record.id ?? ""}|${record.ts ?? ""}`;
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
	if (heartbeatState(target.dir) !== "live") {
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

// --- wait loop (roadmap #2, #3, #5) -----------------------------------------

async function waitForOutcome(target, payload, flags) {
	const outbox = path.join(target.dir, "outbox.jsonl");
	const readNew = makeOutboxReader(outbox);
	readNew(); // consume history up to now
	writeCommand(target, payload);

	const startedAt = Date.now();
	let lastActivityAt = Date.now();
	let accepted = false;
	let bound = false;
	let foreignSeen = false;
	const myRuns = new Set();
	const isPrompt = payload.action === "prompt" || payload.action === "interrupt";

	for (;;) {
		await sleep(POLL_MS);
		const records = readNew();
		if (records.length > 0) lastActivityAt = Date.now();
		for (const record of records) {
			if (flags.verbose) console.error(`[${record.type}]${record.id ? ` id=${record.id}` : ""}`);
			switch (record.type) {
				case "error":
					if (record.id === payload.id) fail(`Bridge error: ${record.error}`, 5);
					break;
				case "pong":
					if (record.id === payload.id) {
						if ((record.protocol ?? 1) < EXPECTED_PROTOCOL)
							console.error(`warning: bridge protocol ${record.protocol ?? 1} — rerun setup + /reload`);
						console.log("pong");
						return 0;
					}
					break;
				case "status_report":
					if (record.id === payload.id) {
						console.log(JSON.stringify(record, null, 2));
						return 0;
					}
					break;
				case "accepted":
					if (record.id === payload.id) {
						accepted = true;
						if (payload.action === "abort") {
							console.log("abort delivered");
							return 0;
						}
						if (record.delivered === "steer-fallback") console.error("note: agent busy — delivered as steer");
						if (record.contended) console.error("note: session is busy (contended) — attribution may be unreliable");
					}
					break;
				case "turn_bound":
					if (record.id === payload.id) bound = true;
					break;
				case "foreign_input":
					if (accepted && !bound) {
						foreignSeen = true;
						if (isPrompt && !flags.acceptPartial) {
							fail(
								"Attribution abandoned: concurrent user input in the Atomic session.\nInspect manually: tail " +
									target.id.slice(0, 8),
								6,
							);
						}
					}
					break;
				case "workflow_started":
					if (record.owner === payload.id) {
						myRuns.add(record.runId);
						console.error(`note: workflow launched (${record.runId}) — waiting for its terminal notice`);
					}
					break;
				case "workflow_lifecycle":
					if (myRuns.has(record.runId) && record.terminal) {
						if (record.kind === "completed") {
							console.log(record.text ?? `workflow ${record.runId} completed`);
							return 0;
						}
						fail(`Workflow ${record.runId} ended: ${record.kind}\n${record.text ?? ""}`, 5);
					}
					break;
				case "agent_settled": {
					if (!accepted) break;
					const owned = record.owner === payload.id;
					const weaklyOwned =
						record.owner === null && !bound && !isPrompt && !foreignSeen && !record.foreignInputSeen;
					if (!owned && !weaklyOwned) break;
					if (record.provisional && myRuns.size > 0) break; // workflow still running
					if (record.provisional && Array.isArray(record.pendingWork)) {
						for (const work of record.pendingWork) if (work.runId) myRuns.add(work.runId);
						console.error("note: turn settled with detached async work — waiting for workflow completion");
						break;
					}
					if (weaklyOwned) console.error("note: weak attribution (steer/follow_up binding is best-effort)");
					console.log(record.text ?? "(agent settled with no assistant text)");
					return 0;
				}
				case "bridge_closed": {
					const reattachUntil = Date.now() + (flags.reattachWindowS ?? 20) * 1000;
					let reattached = false;
					while (Date.now() < reattachUntil) {
						await sleep(500);
						if (readNew().some((r) => r.type === "bridge_ready")) {
							reattached = true;
							break;
						}
					}
					if (reattached) {
						console.error(`note: session ${record.reason === "reload" ? "reloaded" : "replaced"} — reattached`);
						break;
					}
					fail(
						record.reason === "quit"
							? "The Atomic session quit before replying."
							: `The Atomic session was ${record.reason}ed; the command may be lost. Check: tail ${target.id.slice(0, 8)}`,
						5,
					);
					break;
				}
				default:
					break;
			}
		}
		const idleMs = Date.now() - lastActivityAt;
		const totalMs = Date.now() - startedAt;
		if (flags.timeoutS > 0 && totalMs > flags.timeoutS * 1000) {
			if (myRuns.size > 0) fail(`Absolute timeout; workflow still running: ${[...myRuns].join(", ")}`, 7);
			fail(`Absolute timeout after ${flags.timeoutS}s — check later: tail ${target.id.slice(0, 8)}`, 2);
		}
		if (idleMs > flags.idleTimeoutS * 1000) {
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
		lines: 20,
		forS: 0,
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
	if (!["prompt", "steer", "follow_up", "interrupt"].includes(flags.mode)) {
		fail(`Invalid --mode: ${flags.mode} (use prompt|steer|follow_up|interrupt)`);
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
       [--mode prompt|steer|follow_up|interrupt] [--wait]
       [--idle-timeout <s>=120] [--timeout <s>] [--accept-partial]
       [--message-file <path>] [-v]
  tail <target> [--lines <n>]  Print recent outbox records
  follow <target> [--for <s>]  Stream outbox records as they arrive
  abort <target>               Abort the session's current turn
  prune [--older-than <days>]  Delete CLOSED session dirs (never live ones)

Exit codes: 0 ok · 1 usage · 2 timeout · 3 no session · 4 ambiguous
            5 bridge/run error · 6 attribution uncertain · 7 async work detached`;

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
		case "ping": {
			const target = resolveTarget(rest[0]);
			process.exit(
				await waitForOutcome(
					target,
					{ id: newCommandId(), action: "ping" },
					{ ...flags, idleTimeoutS: 10, timeoutS: 10 },
				),
			);
			break;
		}
		case "status": {
			const target = resolveTarget(rest[0]);
			process.exit(
				await waitForOutcome(
					target,
					{ id: newCommandId(), action: "status" },
					{ ...flags, idleTimeoutS: 10, timeoutS: 10 },
				),
			);
			break;
		}
		case "abort": {
			const target = resolveTarget(rest[0]);
			process.exit(
				await waitForOutcome(
					target,
					{ id: newCommandId(), action: "abort" },
					{ ...flags, idleTimeoutS: 15, timeoutS: 15 },
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
			const target = resolveTarget(token);
			const payload = { id: newCommandId(), action: flags.mode, message };
			if (!flags.wait) {
				writeCommand(target, payload);
				console.log(`Sent ${flags.mode} to ${target.name ?? target.id} (command id ${payload.id}).`);
				console.log(`Follow with: follow ${String(target.id).slice(0, 8)} · or read later: tail ${String(target.id).slice(0, 8)}`);
				return;
			}
			process.exit(await waitForOutcome(target, payload, flags));
			break;
		}
		case "tail": {
			const target = resolveTarget(rest[0]);
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
			const target = resolveTarget(rest[0]);
			const readNew = makeOutboxReader(path.join(target.dir, "outbox.jsonl"));
			const until = flags.forS > 0 ? Date.now() + flags.forS * 1000 : Number.POSITIVE_INFINITY;
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
				if (session.state !== "closed") continue;
				const startedAt = Date.parse(String(session.startedAt ?? "")) || 0;
				if (startedAt > cutoff) continue;
				const real = fs.realpathSync(session.dir);
				if (path.relative(realRoot, real).startsWith("..")) continue; // symlink escape guard
				fs.rmSync(session.dir, { recursive: true, force: true });
				removed++;
			}
			console.log(`Pruned ${removed} closed session dir(s).`);
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
