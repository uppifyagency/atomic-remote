/**
 * atomic-remote bridge v2 — Atomic-side half of the atomic-remote Claude Code plugin.
 *
 * Install into ~/.atomic/agent/extensions/ (the plugin's /atomic-remote:setup command
 * does this), then run /reload inside the Atomic session.
 *
 * Each session registers under <agentDir>/remote-bridge/<sessionId>/ with:
 *   meta.json       — stable session identity, status, bridge/protocol version
 *   heartbeat.json  — liveness beacon written every HEARTBEAT_INTERVAL_MS
 *   inbox/          — drop *.json command files here to command the session
 *   outbox.jsonl    — acks, ownership-tagged agent events, workflow lifecycle records
 *
 * Command file shape (id is REQUIRED, [A-Za-z0-9_-]{1,64}):
 *   { "id": "…", "action": "ping" | "status" | "abort" | "prompt" | "steer"
 *                        | "follow_up" | "interrupt", "message": "…" }
 *
 * Protocol guarantees (v2):
 *   - every command gets an ack record (accepted / error), even degenerate input
 *   - commands are processed serially, in filename order, at-least-once
 *     (rename to .processing before injection; leftovers surface as errors)
 *   - agent records carry an `owner` command id when attribution is known
 *   - `agent_settled` is the terminal record for a turn, not `agent_end`
 *   - the bridge NEVER deletes its own directory; on shutdown it marks
 *     meta.status = "closed", clears only inbox/, and emits bridge_closed
 *
 * Injection uses only documented extension APIs (extensions.md):
 *   pi.sendUserMessage / pi.sendMessage, input / agent_* / tool_execution_end /
 *   session_* events, ctx.sessionManager, ctx.isIdle / ctx.abort.
 *
 * SECURITY: anyone who can write to the inbox commands your agent with your
 * full user permissions. Directories are 0700, files 0600. Keep them that way.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";

const BRIDGE_VERSION = "0.2.1";
const PROTOCOL = 2;

const HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_BATCH_PER_TICK = 32;
const OUTBOX_MAX_BYTES = 8 * 1024 * 1024;
const INBOX_SAFETY_SCAN_MS = 10_000; // backstop only; fs.watch is the primary trigger
const WORKFLOW_SCAN_MS = 5_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Controller filenames are <ts:14>-<seq:3>-<id>.json; anything else yields id=null.
const PROCESSING_ID_PATTERN = /^\d{14}-\d{3}-([A-Za-z0-9_-]{1,64})\.json\.processing$/;
const WORKFLOW_TERMINAL_KINDS = ["completed", "failed", "blocked", "quit"] as const;
const WORKFLOW_LIFECYCLE_KINDS = [...WORKFLOW_TERMINAL_KINDS, "paused", "resumed"] as const;

type MessagelessAction = "ping" | "status" | "abort";
type MessageAction = "prompt" | "steer" | "follow_up" | "interrupt";

type BridgeCommand =
	| { action: MessagelessAction; id: string }
	| { action: MessageAction; id: string; message: string };

interface RejectedCommand {
	rejected: true;
	id: string | null;
	reason: string;
	unknownKeys?: string[];
}

interface TextBlock {
	type?: string;
	text?: string;
}

interface MessageLike {
	role?: string;
	content?: unknown;
}

const agentDir = process.env.ATOMIC_CODING_AGENT_DIR ?? path.join(os.homedir(), ".atomic", "agent");
const bridgeRoot = path.join(agentDir, "remote-bridge");

const MESSAGE_ACTIONS: readonly string[] = ["prompt", "steer", "follow_up", "interrupt"];
const ALL_ACTIONS: readonly string[] = ["ping", "status", "abort", ...MESSAGE_ACTIONS];

function normalizeForBinding(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 2000);
}

function extractAssistantText(messages: MessageLike[]): string | null {
	let text: string | null = null;
	for (const message of messages) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const parts = (message.content as TextBlock[])
			.filter((block) => block && block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string);
		if (parts.length > 0) text = parts.join("\n");
	}
	return text;
}

function parseCommand(raw: string): BridgeCommand | RejectedCommand {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { rejected: true, id: null, reason: "invalid JSON" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { rejected: true, id: null, reason: "command must be a JSON object" };
	}
	const record = value as Record<string, unknown>;
	const rawId = record.id;
	const id = typeof rawId === "string" && ID_PATTERN.test(rawId) ? rawId : null;
	if (id === null) {
		return { rejected: true, id: null, reason: "missing or invalid id (required, [A-Za-z0-9_-]{1,64})" };
	}
	const action = record.action;
	if (typeof action !== "string" || !ALL_ACTIONS.includes(action)) {
		return { rejected: true, id, reason: `unknown action: ${String(action)}` };
	}
	const knownKeys = ["id", "action", "message"];
	const unknownKeys = Object.keys(record).filter((key) => !knownKeys.includes(key));
	if (MESSAGE_ACTIONS.includes(action)) {
		const message = record.message;
		if (typeof message !== "string") {
			return { rejected: true, id, reason: `${action} requires a string message`, unknownKeys };
		}
		const trimmed = message.trim();
		if (trimmed.length === 0) {
			return { rejected: true, id, reason: "message is empty", unknownKeys };
		}
		if (message.length > MAX_MESSAGE_CHARS) {
			return { rejected: true, id, reason: `message exceeds ${MAX_MESSAGE_CHARS} chars`, unknownKeys };
		}
		// Reject control characters other than \n, \t, \r.
		if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(message)) {
			return { rejected: true, id, reason: "message contains control characters", unknownKeys };
		}
		return { action: action as MessageAction, id, message };
	}
	return { action: action as MessagelessAction, id };
}

export default function (pi: ExtensionAPI) {
	let watcher: fs.FSWatcher | undefined;
	let sessionDir: string | undefined;
	let inboxDir: string | undefined;
	let outboxPath: string | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let safetyTimer: ReturnType<typeof setInterval> | undefined;
	let workflowTimer: ReturnType<typeof setInterval> | undefined;
	let outboxModeApplied = false;
	let outboxApproxBytes = -1; // -1 = unknown; measured once, then tracked per append
	let agentRunning = false;

	// Attribution state (roadmap #2).
	const pendingBindings = new Map<string, string>(); // normalized text -> command id
	let interruptPending: string | null = null;
	let activeOwner: string | null = null;
	let foreignSinceLastSettle = false;
	let lastTextForOwner: string | null = null;

	// Workflow tracking (roadmap #3).
	const knownRuns = new Map<string, { owner: string | null; terminal: boolean }>();
	let entryCursor = 0;

	// Serial command queue (roadmap #4).
	let chain: Promise<void> = Promise.resolve();

	const emit = (record: Record<string, unknown>) => {
		if (!outboxPath) return;
		try {
			if (!outboxModeApplied && fs.existsSync(outboxPath)) {
				fs.chmodSync(outboxPath, 0o600);
				outboxModeApplied = true;
			}
			if (outboxApproxBytes < 0) {
				try {
					outboxApproxBytes = fs.statSync(outboxPath).size;
				} catch {
					outboxApproxBytes = 0; // first write: file does not exist yet
				}
			}
			if (outboxApproxBytes > OUTBOX_MAX_BYTES) {
				// Readers drain the renamed file from their last offset before switching
				// to the fresh one (same inode), so rotation loses nothing.
				fs.appendFileSync(outboxPath, `${JSON.stringify({ type: "outbox_rotated", ts: new Date().toISOString() })}\n`);
				fs.renameSync(outboxPath, `${outboxPath.replace(/\.jsonl$/, "")}.1.jsonl`);
				outboxApproxBytes = 0;
			}
			const line = `${JSON.stringify({ ...record, ts: new Date().toISOString() })}\n`;
			fs.appendFileSync(outboxPath, line, { mode: 0o600 });
			outboxApproxBytes += Buffer.byteLength(line);
			outboxModeApplied = true;
		} catch {
			// Outbox unwritable: nothing useful to do from inside the engine.
		}
	};

	const readMeta = (): Record<string, unknown> | null => {
		if (!sessionDir) return null;
		try {
			return JSON.parse(fs.readFileSync(path.join(sessionDir, "meta.json"), "utf8")) as Record<string, unknown>;
		} catch {
			return null;
		}
	};

	const writeMeta = (patch: Record<string, unknown>) => {
		if (!sessionDir) return;
		const meta = readMeta() ?? {};
		try {
			fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify({ ...meta, ...patch }, null, 2), {
				mode: 0o600,
			});
		} catch {
			// Best-effort.
		}
	};

	const writeHeartbeat = () => {
		if (!sessionDir) return;
		try {
			fs.writeFileSync(
				path.join(sessionDir, "heartbeat.json"),
				JSON.stringify({ ts: Date.now(), enginePid: process.pid, busy: agentRunning }),
				{ mode: 0o600 },
			);
		} catch {
			// Best-effort.
		}
	};

	const stopTimersAndWatcher = () => {
		watcher?.close();
		watcher = undefined;
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (safetyTimer) clearInterval(safetyTimer);
		if (workflowTimer) clearInterval(workflowTimer);
		heartbeatTimer = undefined;
		safetyTimer = undefined;
		workflowTimer = undefined;
	};

	// Deliberately no automatic GC: the protocol guarantees nothing is deleted
	// implicitly. Cleanup happens only via the controller's explicit `prune`.

	// --- Workflow lifecycle mirroring (roadmap #3) -------------------------

	const hasPendingRuns = () => [...knownRuns.values()].some((run) => !run.terminal);

	const scanEntriesForWorkflows = (ctx: { sessionManager?: { getEntries?: () => unknown[] } }) => {
		if (!hasPendingRuns()) return;
		let entries: unknown[];
		try {
			entries = ctx.sessionManager?.getEntries?.() ?? [];
		} catch {
			return;
		}
		for (; entryCursor < entries.length; entryCursor++) {
			let serialized: string;
			try {
				serialized = JSON.stringify(entries[entryCursor]);
			} catch {
				continue;
			}
			// Best-effort inference: lifecycle notices are recognized by runId plus a
			// terminal keyword in an entry that also mentions "workflow". A false
			// negative degrades to exit 7 at timeout; this guard narrows the false
			// positives (e.g. an assistant message quoting the runId near "completed").
			if (!/workflow/i.test(serialized)) continue;
			for (const [runId, run] of knownRuns) {
				if (run.terminal || !serialized.includes(runId)) continue;
				const kind = WORKFLOW_LIFECYCLE_KINDS.find((candidate) =>
					new RegExp(`\\b${candidate}\\b`, "i").test(serialized),
				);
				if (!kind) continue;
				const terminal = (WORKFLOW_TERMINAL_KINDS as readonly string[]).includes(kind);
				if (terminal) run.terminal = true;
				emit({
					type: "workflow_lifecycle",
					runId,
					kind,
					terminal,
					owner: run.owner,
					text: serialized.slice(0, 2000),
				});
			}
		}
	};

	const ensureWorkflowTimer = (ctx: { sessionManager?: { getEntries?: () => unknown[] } }) => {
		if (workflowTimer || !hasPendingRuns()) return;
		workflowTimer = setInterval(() => {
			scanEntriesForWorkflows(ctx);
			if (!hasPendingRuns() && workflowTimer) {
				clearInterval(workflowTimer);
				workflowTimer = undefined;
			}
		}, WORKFLOW_SCAN_MS);
		workflowTimer.unref?.();
	};

	// --- Command handling (roadmap #4: serial, validated, at-least-once) ---

	const handleCommand = async (
		cmd: BridgeCommand,
		ctx: {
			isIdle?: () => boolean;
			abort?: () => void | Promise<void>;
			hasPendingMessages?: () => boolean;
			sessionManager?: { getEntries?: () => unknown[] };
		},
	) => {
		const contended = (() => {
			try {
				return ctx.isIdle ? !ctx.isIdle() : agentRunning;
			} catch {
				return agentRunning;
			}
		})();
		try {
			switch (cmd.action) {
				case "ping":
					emit({ type: "pong", id: cmd.id, protocol: PROTOCOL, bridgeVersion: BRIDGE_VERSION });
					return;
				case "status": {
					const meta = readMeta();
					emit({
						type: "status_report",
						id: cmd.id,
						idle: !contended,
						busy: agentRunning,
						pendingMessages: (() => {
							try {
								return ctx.hasPendingMessages?.() ?? null;
							} catch {
								return null;
							}
						})(),
						name: meta?.name ?? null,
						sessionFile: meta?.sessionFile ?? null,
						pendingWorkflows: [...knownRuns.entries()]
							.filter(([, run]) => !run.terminal)
							.map(([runId]) => runId),
						protocol: PROTOCOL,
						bridgeVersion: BRIDGE_VERSION,
					});
					return;
				}
				case "abort":
					await Promise.resolve(ctx.abort?.());
					emit({ type: "accepted", id: cmd.id, action: "abort", contended });
					return;
				case "prompt": {
					pendingBindings.set(normalizeForBinding(cmd.message), cmd.id);
					try {
						await Promise.resolve(pi.sendUserMessage(cmd.message));
						emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended });
					} catch {
						await Promise.resolve(pi.sendUserMessage(cmd.message, { deliverAs: "steer" }));
						emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "steer-fallback", contended });
					}
					return;
				}
				case "steer":
					pendingBindings.set(normalizeForBinding(cmd.message), cmd.id);
					await Promise.resolve(pi.sendUserMessage(cmd.message, { deliverAs: "steer" }));
					emit({ type: "accepted", id: cmd.id, action: "steer", delivered: "steer", contended });
					return;
				case "follow_up":
					pendingBindings.set(normalizeForBinding(cmd.message), cmd.id);
					await Promise.resolve(pi.sendUserMessage(cmd.message, { deliverAs: "followUp" }));
					emit({ type: "accepted", id: cmd.id, action: "follow_up", delivered: "followUp", contended });
					return;
				case "interrupt":
					interruptPending = cmd.id;
					await Promise.resolve(
						pi.sendMessage(
							{ customType: "atomic-remote", content: cmd.message, display: true },
							{ triggerTurn: true, deliverAs: "interrupt" },
						),
					);
					emit({ type: "accepted", id: cmd.id, action: "interrupt", contended });
					return;
			}
		} catch (error) {
			if (cmd.action === "interrupt" && interruptPending === cmd.id) interruptPending = null;
			if (cmd.action !== "ping" && cmd.action !== "status" && cmd.action !== "abort") {
				pendingBindings.delete(normalizeForBinding(cmd.message));
			}
			emit({ type: "error", id: cmd.id, error: error instanceof Error ? error.message : String(error) });
		}
	};

	const ingestFile = (
		file: string,
		ctx: Parameters<typeof handleCommand>[1],
	): void => {
		const processing = `${file}.processing`;
		try {
			fs.renameSync(file, processing);
		} catch {
			return; // Another tick claimed it, or it vanished.
		}
		let raw: string | null = null;
		let rejectReason: string | null = null;
		try {
			const fd = fs.openSync(processing, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			try {
				const stat = fs.fstatSync(fd);
				if (!stat.isFile()) rejectReason = "not a regular file";
				else if (stat.size > MAX_COMMAND_BYTES) rejectReason = `command exceeds ${MAX_COMMAND_BYTES} bytes`;
				else {
					const buffer = Buffer.alloc(Number(stat.size));
					fs.readSync(fd, buffer, 0, buffer.length, 0);
					raw = buffer.toString("utf8");
				}
			} finally {
				fs.closeSync(fd);
			}
		} catch (error) {
			rejectReason = `unreadable command file: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (rejectReason !== null || raw === null) {
			emit({ type: "error", id: null, error: rejectReason ?? "empty command file", file: path.basename(file) });
			try {
				fs.rmSync(processing, { force: true });
			} catch {}
			return;
		}
		const parsed = parseCommand(raw);
		if ("rejected" in parsed) {
			emit({
				type: "error",
				id: parsed.id,
				error: parsed.reason,
				...(parsed.unknownKeys?.length ? { unknownKeys: parsed.unknownKeys } : {}),
			});
			try {
				fs.rmSync(processing, { force: true });
			} catch {}
			return;
		}
		chain = chain
			.then(() => handleCommand(parsed, ctx))
			.catch((error) => {
				emit({ type: "error", id: parsed.id, error: error instanceof Error ? error.message : String(error) });
			})
			.then(() => {
				try {
					fs.rmSync(processing, { force: true });
				} catch {}
			});
	};

	const consumeInbox = (ctx: Parameters<typeof handleCommand>[1]) => {
		if (!inboxDir) return;
		let names: string[];
		try {
			names = fs.readdirSync(inboxDir);
		} catch {
			return;
		}
		names
			.filter((name) => name.endsWith(".json"))
			.sort()
			.slice(0, MAX_BATCH_PER_TICK)
			.forEach((name) => ingestFile(path.join(inboxDir as string, name), ctx));
	};

	const recoverInterruptedCommands = () => {
		if (!inboxDir) return;
		let names: string[];
		try {
			names = fs.readdirSync(inboxDir);
		} catch {
			return;
		}
		for (const name of names.filter((n) => n.endsWith(".processing"))) {
			const match = name.match(PROCESSING_ID_PATTERN);
			emit({
				type: "error",
				id: match ? match[1] : null,
				error: "command interrupted by engine restart",
				recoverable: true,
			});
			try {
				fs.rmSync(path.join(inboxDir, name), { force: true });
			} catch {}
		}
	};

	const startWatcher = (ctx: Parameters<typeof handleCommand>[1], attempt = 0) => {
		if (!inboxDir) return;
		try {
			watcher = fs.watch(inboxDir, () => {
				setTimeout(() => consumeInbox(ctx), 30);
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
				emit({ type: "watch_restarted", attempt: attempt + 1 });
				setTimeout(() => startWatcher(ctx, attempt + 1), Math.min(30_000, 1_000 * 2 ** attempt));
			});
		} catch {
			setTimeout(() => startWatcher(ctx, attempt + 1), Math.min(30_000, 1_000 * 2 ** attempt));
		}
	};

	// --- Lifecycle ---------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		stopTimersAndWatcher();

		// A session switch (/new, /resume, /fork) reuses this engine process:
		// everything scoped to the previous session must not leak into this one.
		pendingBindings.clear();
		interruptPending = null;
		activeOwner = null;
		foreignSinceLastSettle = false;
		lastTextForOwner = null;
		knownRuns.clear();
		entryCursor = 0;
		agentRunning = false;
		outboxApproxBytes = -1;

		let sessionId: string | null = null;
		try {
			sessionId = ctx.sessionManager?.getSessionId?.() ?? null;
		} catch {
			sessionId = null;
		}
		const ephemeral = sessionId === null;
		const id = sessionId ?? `eph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		sessionDir = path.join(bridgeRoot, id);
		inboxDir = path.join(sessionDir, "inbox");
		outboxPath = path.join(sessionDir, "outbox.jsonl");
		outboxModeApplied = false;
		fs.mkdirSync(path.join(inboxDir, ".tmp"), { recursive: true, mode: 0o700 });
		try {
			fs.chmodSync(bridgeRoot, 0o700);
			fs.chmodSync(sessionDir, 0o700);
			fs.chmodSync(inboxDir, 0o700);
		} catch {
			// Best-effort on exotic filesystems.
		}

		let sessionFile: string | null = null;
		try {
			sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
		} catch {
			sessionFile = null;
		}
		let name: string | null = null;
		try {
			name = pi.getSessionName?.() ?? null;
		} catch {
			name = null;
		}
		writeMeta({
			id,
			sessionId,
			sessionFile,
			cwd: process.cwd(),
			name: name ?? path.basename(process.cwd()),
			enginePid: process.pid,
			hostPid: process.ppid,
			bridgeVersion: BRIDGE_VERSION,
			protocol: PROTOCOL,
			startedAt: readMeta()?.startedAt ?? new Date().toISOString(),
			status: "live",
			ephemeral,
			reason: (event as { reason?: string }).reason ?? "startup",
		});
		writeHeartbeat();
		emit({
			type: "bridge_ready",
			id,
			protocol: PROTOCOL,
			bridgeVersion: BRIDGE_VERSION,
			enginePid: process.pid,
			cwd: process.cwd(),
			reason: (event as { reason?: string }).reason ?? "startup",
		});

		heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
		heartbeatTimer.unref?.();

		recoverInterruptedCommands();
		consumeInbox(ctx);
		startWatcher(ctx);
		safetyTimer = setInterval(() => consumeInbox(ctx), INBOX_SAFETY_SCAN_MS);
		safetyTimer.unref?.();

		if (ctx.hasUI) {
			ctx.ui.notify(`atomic-remote bridge v${BRIDGE_VERSION} active (${id.slice(0, 8)})`, "info");
		}
	});

	pi.on("session_info_changed", async (event) => {
		const name = (event as { name?: string }).name;
		if (typeof name === "string" && name.length > 0) writeMeta({ name });
	});

	// --- Attribution (roadmap #2) ------------------------------------------

	pi.on("input", async (event) => {
		const source = (event as { source?: string }).source;
		const text = (event as { text?: string }).text ?? "";
		if (source === "extension") {
			const key = normalizeForBinding(text);
			const owner = pendingBindings.get(key);
			if (owner) {
				pendingBindings.delete(key);
				activeOwner = owner;
				emit({ type: "turn_bound", id: owner });
			}
			return;
		}
		if (source === "interactive") {
			// Keep a bound owner: the settle still belongs to that command, but it
			// carries foreignInputSeen so the controller can refuse (exit 6) instead
			// of the reply silently vanishing under an unmatchable owner:null.
			foreignSinceLastSettle = true;
			emit({ type: "foreign_input", preview: normalizeForBinding(text).slice(0, 120) });
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		if (interruptPending !== null && activeOwner === null) {
			activeOwner = interruptPending;
			interruptPending = null;
			emit({ type: "turn_bound", id: activeOwner, via: "interrupt" });
		}
		writeHeartbeat();
		scanEntriesForWorkflows(ctx as { sessionManager?: { getEntries?: () => unknown[] } });
		emit({ type: "agent_start", owner: activeOwner });
	});

	pi.on("agent_end", async (event) => {
		const messages = ((event as { messages?: MessageLike[] }).messages ?? []) as MessageLike[];
		const text = extractAssistantText(messages);
		if (text !== null) lastTextForOwner = text;
		emit({ type: "agent_end", owner: activeOwner, text });
	});

	pi.on("agent_settled", async (_event, ctx) => {
		agentRunning = false;
		writeHeartbeat();
		scanEntriesForWorkflows(ctx as { sessionManager?: { getEntries?: () => unknown[] } });
		const pendingWork = [...knownRuns.entries()]
			.filter(([, run]) => !run.terminal)
			.map(([runId]) => ({ kind: "workflow", runId }));
		emit({
			type: "agent_settled",
			owner: activeOwner,
			foreignInputSeen: foreignSinceLastSettle,
			text: lastTextForOwner,
			...(pendingWork.length > 0 ? { provisional: true, pendingWork } : {}),
		});
		ensureWorkflowTimer(ctx as { sessionManager?: { getEntries?: () => unknown[] } });
		activeOwner = null;
		// An interrupt binding that never claimed a turn is stale once the session
		// settles; leaving it set would misattribute the next unrelated turn.
		interruptPending = null;
		foreignSinceLastSettle = false;
		lastTextForOwner = null;
	});

	// --- Workflow launches (roadmap #3) --------------------------------------

	pi.on("tool_execution_end", async (event) => {
		const toolName = (event as { toolName?: string }).toolName;
		const isError = (event as { isError?: boolean }).isError;
		if (toolName !== "workflow" || isError) return;
		let serialized: string;
		try {
			serialized = JSON.stringify((event as { result?: unknown }).result ?? "");
		} catch {
			return;
		}
		const match = serialized.match(RUN_ID_PATTERN);
		if (!match) return;
		const runId = match[0].toLowerCase();
		if (knownRuns.has(runId)) return;
		knownRuns.set(runId, { owner: activeOwner, terminal: false });
		emit({ type: "workflow_started", runId, owner: activeOwner });
	});

	// --- Shutdown (roadmap #5: never delete history) -------------------------

	pi.on("session_shutdown", async (event) => {
		const reason = (event as { reason?: string }).reason ?? "quit";
		const targetSessionFile = (event as { targetSessionFile?: string }).targetSessionFile ?? null;
		emit({ type: "bridge_closed", reason, targetSessionFile });
		writeMeta({ status: "closed", closedAt: new Date().toISOString(), closeReason: reason });
		stopTimersAndWatcher();
		if (inboxDir) {
			try {
				fs.rmSync(inboxDir, { recursive: true, force: true });
			} catch {
				// Pending commands must not survive a dead session (replay vector).
			}
		}
		sessionDir = undefined;
		inboxDir = undefined;
		outboxPath = undefined;
	});

	pi.registerCommand("remote-name", {
		description: "Set the atomic-remote bridge name for this session (targeting alias)",
		handler: async (args, ctx) => {
			if (!sessionDir) {
				ctx.ui.notify("atomic-remote bridge is not active", "warning");
				return;
			}
			const name = (args ?? "").trim();
			writeMeta({ name: name.length > 0 ? name : path.basename(process.cwd()) });
			ctx.ui.notify(name ? `atomic-remote name: ${name}` : "atomic-remote name reset", "info");
		},
	});
}
