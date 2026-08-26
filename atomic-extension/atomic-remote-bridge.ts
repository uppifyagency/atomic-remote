/**
 * atomic-remote bridge v0.3.1 — Atomic-side half of the atomic-remote Claude Code plugin.
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
 *                        | "follow_up" | "interrupt" | "command", "message": "…",
 *     "plan"?: {…} }                      // prompt/follow_up only, ≤ 8 KiB
 *   { "id": "…", "action": "run_workflow", "workflowName": "…",
 *     "workflowSource": "…", "args"?: "…" }  // its command file may reach 256 KiB
 *
 * Protocol additions (v3):
 *   - "command" injects a leading-slash message with expandPromptTemplates:true,
 *     so it dispatches as a real slash command instead of chat text
 *   - a "plan" object is persisted to <sessionDir>/plans/<id>.json and inlined
 *     into the injected message (structured handoff, not prose)
 *   - "run_workflow" installs a workflow TS into <cwd>/.atomic/workflows/,
 *     injects /workflow reload then /workflow <name> (deterministic entry);
 *     emits workflow_installed {targetPath, overwrote}
 *   - workflow lifecycle is mirrored structurally from custom_message entries
 *     (customType "workflows:lifecycle-notice"): workflow_lifecycle records now
 *     carry scope/workflowName/status/stage fields; terminal only for run scope
 *   - status_report busy/idle come from one source of truth (engine isIdle)
 *
 * Protocol guarantees (v2, unchanged unless noted):
 *   - every command gets an ack record (accepted / error), even degenerate input
 *   - injection commands are processed serially, in filename order,
 *     at-least-once (rename to .processing before injection; leftovers surface
 *     as errors); since 0.3.1 the control actions ping/status/abort are
 *     handled immediately instead of queued behind injections
 *   - agent records carry an `owner` command id when attribution is known
 *   - `agent_settled` is the terminal record for a turn, not `agent_end`
 *   - an interrupt preempts a bound owner: it claims the next turn, and the
 *     preempted command's settle carries `aborted: true` under its own id
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

const BRIDGE_VERSION = "0.3.1";
const PROTOCOL = 3;

const HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_COMMAND_BYTES = 64 * 1024;
// run_workflow carries a generated TS source, not a chat message; it gets its own cap.
const MAX_WORKFLOW_COMMAND_BYTES = 256 * 1024;
const MAX_PLAN_BYTES = 8 * 1024;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_BATCH_PER_TICK = 32;
const INBOX_SAFETY_SCAN_MS = 10_000; // backstop only; fs.watch is the primary trigger
// Test seam: suites shrink the settle and TTL windows to keep the suite fast;
// production never sets these variables.
const envMs = (name: string, fallback: number): number => {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};
// Engine race, observed live (atomic 0.9.15): pi.sendUserMessage is
// fire-and-forget, and workflow name resolution does not await an in-flight
// reload (ensureWorkflowResourcesLoaded only waits while no discovery exists
// at all), so a run injected right after /workflow reload can execute the
// pre-reload module. No completion signal reaches extensions; a bounded settle
// between the two injections is the only lever this side of the boundary.
// The upstream fix (branch fix/workflows-await-inflight-reload) is submitted;
// drop this only when the oldest supported Atomic release ships it.
const RELOAD_SETTLE_MS = envMs("ATOMIC_REMOTE_RELOAD_SETTLE_MS", 5_000);
// A binding or armed launch that nothing ever claimed is a misattribution in
// waiting: expire it loudly instead of letting it capture a future turn.
const BINDING_TTL_MS = envMs("ATOMIC_REMOTE_BINDING_TTL_MS", 600_000);
const BINDING_CAP = 32;
const LAUNCH_TTL_MS = envMs("ATOMIC_REMOTE_LAUNCH_TTL_MS", 60_000);
const OUTBOX_MAX_BYTES = envMs("ATOMIC_REMOTE_OUTBOX_MAX_BYTES", 8 * 1024 * 1024);
const WORKFLOW_SCAN_MS = 5_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const WORKFLOW_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
// Controller filenames are <ts:14>-<seq:3>-<id>.json; anything else yields id=null.
const PROCESSING_ID_PATTERN = /^\d{14}-\d{3}-([A-Za-z0-9_-]{1,64})\.json\.processing$/;
const WORKFLOW_LIFECYCLE_CUSTOM_TYPE = "workflows:lifecycle-notice";
// Heartbeat cards arrive at most once per heartbeatIntervalMinutes (15 min
// default) per run: mirroring them keeps the outbox low-cardinality while
// feeding the controller's idle timeout during long silent runs.
const WORKFLOW_HEARTBEAT_CUSTOM_TYPE = "workflows:workflow-heartbeat";
// terminal is true only for run-scope terminal kinds: a stage completing must not
// end a controller's wait for the whole run.
const WORKFLOW_TERMINAL_KINDS: readonly string[] = ["completed", "failed", "blocked", "quit"];

type MessagelessAction = "ping" | "status" | "abort";
type MessageAction = "prompt" | "steer" | "follow_up" | "interrupt" | "command";

type BridgeCommand =
	| { action: MessagelessAction; id: string; include?: readonly string[] }
	| { action: MessageAction; id: string; message: string; plan?: Record<string, unknown> }
	| { action: "run_workflow"; id: string; workflowName: string; workflowSource: string; args?: string };

interface WorkflowLifecycleDetails {
	kind?: string;
	scope?: string;
	runId?: string;
	workflowName?: string;
	status?: string;
	stageId?: string;
	stageName?: string;
	failedStageId?: string;
	error?: string;
}

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

const MESSAGE_ACTIONS: readonly string[] = ["prompt", "steer", "follow_up", "interrupt", "command"];
// Control lane: actions that inject nothing into the conversation. They are
// handled immediately instead of queued, so a status or abort never waits
// behind an injection command (run_workflow alone sleeps RELOAD_SETTLE_MS).
const CONTROL_ACTIONS: readonly string[] = ["ping", "status", "abort"];
const PLAN_ACTIONS: readonly string[] = ["prompt", "follow_up"];
const ALL_ACTIONS: readonly string[] = ["ping", "status", "abort", "run_workflow", ...MESSAGE_ACTIONS];

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
	if (action === "run_workflow") {
		const wfKnownKeys = ["id", "action", "workflowName", "workflowSource", "args"];
		const wfUnknownKeys = Object.keys(record).filter((key) => !wfKnownKeys.includes(key));
		const workflowName = record.workflowName;
		if (typeof workflowName !== "string" || !WORKFLOW_NAME_PATTERN.test(workflowName)) {
			return {
				rejected: true,
				id,
				reason: "run_workflow requires workflowName ([a-z0-9-]{1,64})",
				unknownKeys: wfUnknownKeys,
			};
		}
		const workflowSource = record.workflowSource;
		if (typeof workflowSource !== "string" || workflowSource.trim().length === 0) {
			return { rejected: true, id, reason: "run_workflow requires a non-empty workflowSource", unknownKeys: wfUnknownKeys };
		}
		const args = record.args;
		if (args !== undefined && (typeof args !== "string" || args.includes("\n") || args.length > 2000)) {
			return {
				rejected: true,
				id,
				reason: "run_workflow args must be a single-line string of at most 2000 chars",
				unknownKeys: wfUnknownKeys,
			};
		}
		return { action: "run_workflow", id, workflowName, workflowSource, ...(args !== undefined ? { args } : {}) };
	}
	const knownKeys = ["id", "action", "message", "plan"];
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
		if (action === "command" && !trimmed.startsWith("/")) {
			return { rejected: true, id, reason: "command requires a message starting with /", unknownKeys };
		}
		const plan = record.plan;
		if (plan !== undefined) {
			if (!PLAN_ACTIONS.includes(action)) {
				return { rejected: true, id, reason: `plan is only allowed on ${PLAN_ACTIONS.join("/")}`, unknownKeys };
			}
			if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
				return { rejected: true, id, reason: "plan must be a JSON object", unknownKeys };
			}
			if (Buffer.byteLength(JSON.stringify(plan)) > MAX_PLAN_BYTES) {
				return { rejected: true, id, reason: `plan exceeds ${MAX_PLAN_BYTES} bytes`, unknownKeys };
			}
		}
		return {
			action: action as MessageAction,
			id,
			message,
			...(plan !== undefined ? { plan: plan as Record<string, unknown> } : {}),
		};
	}
	// Optional opt-in sections for status; unknown values are dropped so a
	// newer controller degrades to a plain report instead of an error.
	const include = record.include;
	if (include !== undefined) {
		if (!Array.isArray(include) || include.some((value) => typeof value !== "string")) {
			return { rejected: true, id, reason: "include must be an array of strings" };
		}
		const known = (include as string[]).filter((value) => value === "commands");
		return { action: action as MessagelessAction, id, ...(known.length > 0 ? { include: known } : {}) };
	}
	return { action: action as MessagelessAction, id };
}

// The slash surface pi.getCommands() advertises; null when the host cannot
// say (then command dispatch stays permissive rather than refusing blind).
function knownCommandNames(pi: unknown): string[] | null {
	try {
		const list = (pi as { getCommands?: () => unknown }).getCommands?.();
		if (!Array.isArray(list) || list.length === 0) return null;
		const names = list
			.map((command) => (command as { name?: unknown } | null)?.name)
			.filter((name): name is string => typeof name === "string")
			// SlashCommandInfo names are documented without the slash, but the
			// advertised forms are written "/name" in prose: accept either shape.
			.map((name) => (name.startsWith("/") ? name.slice(1) : name));
		return names.length > 0 ? names : null;
	} catch {
		return null;
	}
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
	// Total order across rotations and engine restarts: a millisecond base makes
	// a replacement instance's first seq larger than anything the old one wrote,
	// as long as the old instance emitted fewer records than the milliseconds it
	// lived (an outbox is low-cardinality by design; >1000 records/s sustained
	// would break this bound before it broke anything else).
	let seqCounter = Date.now();
	let agentRunning = false;
	let engineCtx: { isIdle?: () => boolean } | undefined;

	// Single source of truth for busy/idle: the engine's own isIdle() when it
	// exists, agentRunning only as the fallback. agentRunning drifts when an
	// agent_settled is missed; trusting it alongside isIdle produced live
	// status_reports saying idle:true and busy:true at once.
	const isContended = () => {
		try {
			return engineCtx?.isIdle ? !engineCtx.isIdle() : agentRunning;
		} catch {
			return agentRunning;
		}
	};

	// Attribution state (roadmap #2).
	const pendingBindings = new Map<string, { id: string; at: number }>(); // normalized text -> pending owner
	let interruptPending: string | null = null;
	let activeOwner: string | null = null;
	let preemptedOwner: string | null = null; // owner whose turn an interrupt aborted
	let endSeenSinceStart = false;
	let foreignSinceLastSettle = false;
	let lastTextForOwner: string | null = null;

	// Workflow tracking (roadmap #3).
	const knownRuns = new Map<string, { owner: string | null; terminal: boolean }>();
	let entryCursor = 0;
	// Durable cursor: the id of the last scanned entry, persisted in meta.json.
	// Entry ids are stable, so a /reload resumes where the previous extension
	// instance stopped instead of re-emitting the whole mirrored history.
	let lastEntryId: string | null = null;
	// A slash-launched run never passes through the model's workflow tool (no
	// tool_execution_end) and a handled slash command emits no input event, so
	// run_workflow attribution binds via the run's own "started" notice, matched
	// by workflow name.
	let pendingWorkflowLaunch: { owner: string; workflowName: string; armedAt: number } | null = null;

	// Expire unclaimed attribution state. Runs on every event that could
	// otherwise consume it, plus the inbox safety tick.
	const sweepPendingState = () => {
		const now = Date.now();
		// Both expiries are deliberately NOT error records: a queued follow_up can
		// legitimately outlive the binding TTL (input timing at delivery is
		// undocumented), and a cold-start workflow admission can outlive the
		// launch TTL. An error record would fail a possibly-live --wait with a
		// spurious exit 5; a typed note prevents future capture without killing it.
		for (const [key, binding] of pendingBindings) {
			if (now - binding.at > BINDING_TTL_MS) {
				pendingBindings.delete(key);
				emit({ type: "binding_expired", id: binding.id, reason: "ttl" });
			}
		}
		if (pendingWorkflowLaunch !== null && now - pendingWorkflowLaunch.armedAt > LAUNCH_TTL_MS) {
			emit({
				type: "workflow_launch_expired",
				id: pendingWorkflowLaunch.owner,
				workflowName: pendingWorkflowLaunch.workflowName,
			});
			pendingWorkflowLaunch = null;
		}
	};

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
				fs.appendFileSync(
					outboxPath,
					`${JSON.stringify({ type: "outbox_rotated", seq: seqCounter++, ts: new Date().toISOString() })}\n`,
				);
				fs.renameSync(outboxPath, `${outboxPath.replace(/\.jsonl$/, "")}.1.jsonl`);
				outboxApproxBytes = 0;
			}
			const line = `${JSON.stringify({ ...record, seq: seqCounter++, ts: new Date().toISOString() })}\n`;
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
				JSON.stringify({ ts: Date.now(), enginePid: process.pid, busy: isContended() }),
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

	// Structural mirroring: @bastani/workflows appends its lifecycle notices as
	// custom_message entries with typed details. Reading those replaces the v2
	// regex-over-JSON.stringify heuristic, whose false negatives degraded to
	// exit-7 timeouts and whose false positives fired on assistant text quoting
	// a runId near the word "completed".
	const scanEntriesForWorkflows = (ctx: { sessionManager?: { getEntries?: () => unknown[] } }) => {
		let entries: unknown[];
		try {
			entries = ctx.sessionManager?.getEntries?.() ?? [];
		} catch {
			return;
		}
		if (entryCursor === 0 && lastEntryId !== null) {
			// Fresh extension instance on an existing session: resume after the
			// last entry the previous instance scanned. Not found (new session,
			// different tree) means scan from the top.
			for (let i = entries.length - 1; i >= 0; i--) {
				if ((entries[i] as { id?: unknown } | null)?.id === lastEntryId) {
					entryCursor = i + 1;
					break;
				}
			}
		}
		for (; entryCursor < entries.length; entryCursor++) {
			const entry = entries[entryCursor] as {
				type?: string;
				customType?: string;
				details?: WorkflowLifecycleDetails;
				content?: unknown;
			} | null;
			if (entry?.type !== "custom_message") continue;
			if (entry.customType === WORKFLOW_HEARTBEAT_CUSTOM_TYPE) {
				const heartbeat = entry.details as { runId?: unknown; workflowName?: unknown } | undefined;
				if (typeof heartbeat?.runId !== "string") continue;
				const hbRunId = heartbeat.runId.toLowerCase();
				emit({
					type: "workflow_heartbeat",
					runId: hbRunId,
					owner: knownRuns.get(hbRunId)?.owner ?? null,
					workflowName: typeof heartbeat.workflowName === "string" ? heartbeat.workflowName : null,
					text: typeof entry.content === "string" ? entry.content.slice(0, 500) : null,
				});
				continue;
			}
			if (entry.customType !== WORKFLOW_LIFECYCLE_CUSTOM_TYPE) continue;
			const details = entry.details;
			if (!details || typeof details.runId !== "string" || typeof details.kind !== "string") continue;
			const runId = details.runId.toLowerCase();
			let run = knownRuns.get(runId);
			if (!run) {
				// First sight via a lifecycle notice (tool event missed, or the run
				// was started by the user): register it so status can report it.
				run = { owner: null, terminal: false };
				if (
					pendingWorkflowLaunch !== null &&
					details.kind === "started" &&
					details.scope !== "stage" &&
					details.workflowName === pendingWorkflowLaunch.workflowName
				) {
					run.owner = pendingWorkflowLaunch.owner;
					pendingWorkflowLaunch = null;
					emit({ type: "workflow_started", runId, owner: run.owner });
				}
				knownRuns.set(runId, run);
			}
			const scope = details.scope === "stage" ? "stage" : "run";
			const terminal = scope === "run" && WORKFLOW_TERMINAL_KINDS.includes(details.kind);
			if (terminal) run.terminal = true;
			emit({
				type: "workflow_lifecycle",
				runId,
				kind: details.kind,
				terminal,
				owner: run.owner,
				scope,
				workflowName: details.workflowName ?? null,
				status: details.status ?? null,
				...(details.stageId ? { stageId: details.stageId } : {}),
				...(details.stageName ? { stageName: details.stageName } : {}),
				...(details.failedStageId ? { failedStageId: details.failedStageId } : {}),
				...(details.error ? { error: String(details.error).slice(0, 2000) } : {}),
				text: typeof entry.content === "string" ? entry.content.slice(0, 2000) : null,
			});
		}
		if (entries.length > 0) {
			const tailId = (entries[entries.length - 1] as { id?: unknown } | null)?.id;
			if (typeof tailId === "string" && tailId !== lastEntryId) {
				lastEntryId = tailId;
				// In-flight runs must survive alongside the cursor: a fresh instance
				// that resumes after lastEntryId never re-reads their notices, so
				// without this it would report no pendingWorkflows after a /reload
				// and settle non-provisionally while a run is still alive.
				writeMeta({
					lastEntryId,
					pendingRuns: [...knownRuns.entries()]
						.filter(([, run]) => !run.terminal)
						.map(([runId, run]) => ({ runId, owner: run.owner })),
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
		engineCtx = ctx;
		const contended = isContended();
		let bindingKey: string | null = null;
		const bind = (text: string) => {
			bindingKey = normalizeForBinding(text);
			if (pendingBindings.size >= BINDING_CAP) {
				const oldest = pendingBindings.entries().next().value;
				if (oldest) {
					pendingBindings.delete(oldest[0]);
					emit({ type: "binding_expired", id: oldest[1].id, reason: "evicted" });
				}
			}
			pendingBindings.set(bindingKey, { id: cmd.id, at: Date.now() });
		};
		// A plan travels the channel as structure and lands twice: as a durable
		// artifact under plans/ and inline in the injected message, so the agent
		// needs no extra turn to read it.
		const composeMessage = (message: string, plan: Record<string, unknown> | undefined): string => {
			if (!plan || !sessionDir) return message;
			const plansDir = path.join(sessionDir, "plans");
			const planPath = path.join(plansDir, `${cmd.id}.json`);
			fs.mkdirSync(plansDir, { recursive: true, mode: 0o700 });
			fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });
			return `${message}\n\nPlan artifact (atomic-remote/plan@1, persisted at ${planPath}):\n${JSON.stringify(plan, null, 2)}`;
		};
		const planPathOf = () => (sessionDir ? path.join(sessionDir, "plans", `${cmd.id}.json`) : null);
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
						busy: contended,
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
						...(cmd.include?.includes("commands") ? { commands: knownCommandNames(pi) ?? [] } : {}),
					});
					return;
				}
				case "abort":
					await Promise.resolve(ctx.abort?.());
					emit({ type: "accepted", id: cmd.id, action: "abort", contended });
					return;
				case "prompt": {
					const injected = composeMessage(cmd.message, cmd.plan);
					bind(injected);
					const planExtra = cmd.plan ? { planPath: planPathOf() } : {};
					try {
						await Promise.resolve(pi.sendUserMessage(injected));
						emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "immediate", contended, ...planExtra });
					} catch {
						await Promise.resolve(pi.sendUserMessage(injected, { deliverAs: "steer" }));
						emit({ type: "accepted", id: cmd.id, action: "prompt", delivered: "steer-fallback", contended, ...planExtra });
					}
					return;
				}
				case "steer":
					bind(cmd.message);
					await Promise.resolve(pi.sendUserMessage(cmd.message, { deliverAs: "steer" }));
					emit({ type: "accepted", id: cmd.id, action: "steer", delivered: "steer", contended });
					return;
				case "follow_up": {
					const injected = composeMessage(cmd.message, cmd.plan);
					bind(injected);
					await Promise.resolve(pi.sendUserMessage(injected, { deliverAs: "followUp" }));
					emit({
						type: "accepted",
						id: cmd.id,
						action: "follow_up",
						delivered: "followUp",
						contended,
						...(cmd.plan ? { planPath: planPathOf() } : {}),
					});
					return;
				}
				case "command": {
					// Validate the slash name against the session's advertised surface:
					// an unknown command would degrade to chat text the model may or
					// may not obey — the silent failure this action exists to avoid.
					const slashName = cmd.message.trim().slice(1).split(/\s+/)[0] ?? "";
					const known = knownCommandNames(pi);
					if (known && !known.includes(slashName)) {
						emit({
							type: "error",
							id: cmd.id,
							error: `unknown slash command: /${slashName}`,
							available: known.slice(0, 20),
						});
						return;
					}
					// expandPromptTemplates is load-bearing: without it the injected
					// slash command is plain chat text for the model, not a dispatch.
					bind(cmd.message);
					await Promise.resolve(pi.sendUserMessage(cmd.message, { expandPromptTemplates: true }));
					emit({ type: "accepted", id: cmd.id, action: "command", delivered: "command", contended });
					return;
				}
				case "run_workflow": {
					const cwd = String(readMeta()?.cwd ?? process.cwd());
					const workflowDir = path.join(cwd, ".atomic", "workflows");
					fs.mkdirSync(workflowDir, { recursive: true });
					const targetPath = path.join(workflowDir, `${cmd.workflowName}.ts`);
					const overwrote = fs.existsSync(targetPath);
					fs.writeFileSync(targetPath, cmd.workflowSource, { mode: 0o600 });
					// Overwriting a hand-written workflow must be visible, never silent.
					emit({ type: "workflow_installed", id: cmd.id, workflowName: cmd.workflowName, targetPath, overwrote });
					await Promise.resolve(pi.sendUserMessage("/workflow reload", { expandPromptTemplates: true }));
					await new Promise((resolve) => setTimeout(resolve, RELOAD_SETTLE_MS));
					// Registered command syntax is `/workflow <name> [key=value…]` — there
					// is no `run` subcommand on the slash surface (that word is the tool
					// action vocabulary). Verified live: `/workflow run x` errors with
					// "Workflow not found: run".
					const runText = `/workflow ${cmd.workflowName}${cmd.args ? ` ${cmd.args}` : ""}`;
					// A handled slash command emits no input event: attribution comes
					// from the "started" lifecycle notice, not from a text binding.
					pendingWorkflowLaunch = { owner: cmd.id, workflowName: cmd.workflowName, armedAt: Date.now() };
					await Promise.resolve(pi.sendUserMessage(runText, { expandPromptTemplates: true }));
					emit({ type: "accepted", id: cmd.id, action: "run_workflow", workflowName: cmd.workflowName, contended });
					return;
				}
				case "interrupt":
					interruptPending = cmd.id;
					await Promise.resolve(
						pi.sendMessage(
							{ customType: "atomic-remote", content: cmd.message, display: true },
							{
								triggerTurn: true,
								deliverAs: "interrupt",
								// Replaces the generic abort result in the model's context, so
								// the transcript says why the previous turn died.
								interruptAbortMessage: `interrupted by atomic-remote command ${cmd.id}`,
							},
						),
					);
					emit({ type: "accepted", id: cmd.id, action: "interrupt", contended });
					return;
			}
		} catch (error) {
			if (cmd.action === "interrupt" && interruptPending === cmd.id) interruptPending = null;
			if (cmd.action === "run_workflow" && pendingWorkflowLaunch?.owner === cmd.id) pendingWorkflowLaunch = null;
			if (bindingKey !== null) pendingBindings.delete(bindingKey);
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
				else if (stat.size > MAX_WORKFLOW_COMMAND_BYTES)
					rejectReason = `command exceeds ${MAX_WORKFLOW_COMMAND_BYTES} bytes`;
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
		if (Buffer.byteLength(raw) > MAX_COMMAND_BYTES) {
			// Only run_workflow earns the larger cap: it ships a TS source, not chat.
			let action: unknown;
			try {
				action = (JSON.parse(raw) as Record<string, unknown>).action;
			} catch {
				action = null;
			}
			if (action !== "run_workflow") {
				emit({ type: "error", id: null, error: `command exceeds ${MAX_COMMAND_BYTES} bytes`, file: path.basename(file) });
				try {
					fs.rmSync(processing, { force: true });
				} catch {}
				return;
			}
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
		const cleanup = () => {
			try {
				fs.rmSync(processing, { force: true });
			} catch {}
		};
		const report = (error: unknown) => {
			emit({ type: "error", id: parsed.id, error: error instanceof Error ? error.message : String(error) });
		};
		if (CONTROL_ACTIONS.includes(parsed.action)) {
			// No shared write target with the injection lane: safe to run now.
			void handleCommand(parsed, ctx).catch(report).then(cleanup);
			return;
		}
		chain = chain.then(() => handleCommand(parsed, ctx)).catch(report).then(cleanup);
	};

	const consumeInbox = (ctx: Parameters<typeof handleCommand>[1]) => {
		sweepPendingState();
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
		engineCtx = ctx as { isIdle?: () => boolean };

		// A session switch (/new, /resume, /fork) reuses this engine process:
		// everything scoped to the previous session must not leak into this one.
		pendingBindings.clear();
		pendingWorkflowLaunch = null;
		interruptPending = null;
		activeOwner = null;
		preemptedOwner = null;
		endSeenSinceStart = false;
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
		// Resume the durable entry cursor left by a previous instance of this
		// same session (reload / engine replacement); a new session dir has none.
		lastEntryId = ((): string | null => {
			const previous = readMeta()?.lastEntryId;
			return typeof previous === "string" ? previous : null;
		})();
		// Rebuild the in-flight runs the previous instance was tracking: the
		// resumed cursor deliberately skips their already-mirrored notices.
		if (lastEntryId !== null) {
			const persisted = readMeta()?.pendingRuns;
			if (Array.isArray(persisted)) {
				for (const item of persisted) {
					const runId = (item as { runId?: unknown } | null)?.runId;
					if (typeof runId !== "string") continue;
					const owner = (item as { owner?: unknown }).owner;
					knownRuns.set(runId, { owner: typeof owner === "string" ? owner : null, terminal: false });
				}
			}
		}
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
		sweepPendingState();
		const source = (event as { source?: string }).source;
		const text = (event as { text?: string }).text ?? "";
		if (source === "extension") {
			const key = normalizeForBinding(text);
			const binding = pendingBindings.get(key);
			if (binding) {
				pendingBindings.delete(key);
				activeOwner = binding.id;
				emit({ type: "turn_bound", id: binding.id });
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
		sweepPendingState();
		agentRunning = true;
		endSeenSinceStart = false;
		if (interruptPending !== null) {
			// deliverAs "interrupt" aborts the active turn and starts this one, so the
			// interrupt claims the turn even over a still-bound owner (preemption).
			// The preempted owner is kept: its aborted run may still settle late.
			if (activeOwner !== null) preemptedOwner = activeOwner;
			activeOwner = interruptPending;
			interruptPending = null;
			emit({ type: "turn_bound", id: activeOwner, via: "interrupt" });
		}
		writeHeartbeat();
		scanEntriesForWorkflows(ctx as { sessionManager?: { getEntries?: () => unknown[] } });
		emit({ type: "agent_start", owner: activeOwner });
	});

	pi.on("agent_end", async (event) => {
		endSeenSinceStart = true;
		const messages = ((event as { messages?: MessageLike[] }).messages ?? []) as MessageLike[];
		const text = extractAssistantText(messages);
		if (text !== null) lastTextForOwner = text;
		emit({ type: "agent_end", owner: activeOwner, text });
	});

	pi.on("agent_settled", async (_event, ctx) => {
		sweepPendingState();
		// A settle can only be the interrupt's own once the engine has nothing
		// left to run: agent_settled means "no automatic continuation left"
		// (extensions.md), so a settle arriving while the engine is still busy
		// belongs to the preempted run, whatever agent_end ordering said.
		// Accepted residual risk: if the engine ever reported busy at the
		// interrupt's OWN settle (contradicting the documented settle semantics)
		// AND the aborted run never settled first, this branch would steal it and
		// the interrupt --wait would end at its idle timeout (bounded exit 2, not
		// a hang). The two observable signals are otherwise symmetric; no
		// discriminator on these events can separate that case.
		const engineStillBusy = (() => {
			const engine = ctx as { isIdle?: () => boolean };
			try {
				return engine?.isIdle ? !engine.isIdle() : false;
			} catch {
				return false;
			}
		})();
		if (preemptedOwner !== null && (!endSeenSinceStart || engineStillBusy)) {
			// The preempted run settling late, after the interrupt's turn already
			// started (live-observed ordering). Attribute it to the old owner as
			// aborted and leave the running interrupt turn's state untouched.
			emit({
				type: "agent_settled",
				owner: preemptedOwner,
				aborted: true,
				foreignInputSeen: foreignSinceLastSettle,
				text: lastTextForOwner,
			});
			preemptedOwner = null;
			lastTextForOwner = null;
			return;
		}
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
		// settles; leaving it set would misattribute the next unrelated turn. The
		// same goes for a preempted owner whose aborted settle never arrived.
		interruptPending = null;
		preemptedOwner = null;
		foreignSinceLastSettle = false;
		lastTextForOwner = null;
	});

	// --- Workflow launches (roadmap #3) --------------------------------------

	pi.on("tool_execution_end", async (event) => {
		const toolName = (event as { toolName?: string }).toolName;
		const isError = (event as { isError?: boolean }).isError;
		if (toolName !== "workflow" || isError) return;
		// The workflow tool returns { content, details } where details carries the
		// structured runId; no serialization or UUID regex involved.
		const result = (event as { result?: { details?: { runId?: unknown } } }).result;
		const rawRunId = result?.details?.runId;
		if (typeof rawRunId !== "string" || rawRunId.length === 0) return;
		const runId = rawRunId.toLowerCase();
		const existing = knownRuns.get(runId);
		if (existing) {
			if (existing.owner === null && activeOwner !== null) {
				// Registered first via a lifecycle notice: the tool result is the
				// attribution authority, so claim it for the active command.
				existing.owner = activeOwner;
				emit({ type: "workflow_started", runId, owner: activeOwner });
			}
			return;
		}
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
		engineCtx = undefined;
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
