import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CTL = fileURLToPath(new URL("../scripts/atomic-ctl.mjs", import.meta.url));
export const RPC_RUN = fileURLToPath(new URL("../scripts/rpc-run.mjs", import.meta.url));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function makeAgentDir() {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-test-"));
	fs.mkdirSync(path.join(agentDir, "remote-bridge"), { recursive: true });
	return agentDir;
}

let emitClock = Date.now();
let sessionSeq = 0;

export function makeSession(agentDir, options = {}) {
	const id = options.id ?? `sess-${String(sessionSeq++).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
	const dir = path.join(agentDir, "remote-bridge", id);
	const inboxDir = path.join(dir, "inbox");
	const outboxPath = path.join(dir, "outbox.jsonl");
	fs.mkdirSync(path.join(inboxDir, ".tmp"), { recursive: true });
	const meta = {
		id,
		sessionId: id,
		sessionFile: null,
		cwd: options.cwd ?? `/tmp/proj-${id}`,
		name: options.name ?? `name-${id}`,
		bridgeVersion: "0.2.1",
		protocol: options.protocol ?? 2,
		startedAt: options.startedAt ?? new Date().toISOString(),
		status: options.status ?? "live",
		...(options.closedAt ? { closedAt: options.closedAt } : {}),
	};
	fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

	const session = {
		id,
		dir,
		inboxDir,
		outboxPath,
		meta,
		heartbeat({ ageMs = 0, busy = false } = {}) {
			fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ ts: Date.now() - ageMs, enginePid: 1, busy }));
		},
		patchMeta(patch) {
			Object.assign(meta, patch);
			fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
		},
		emit(record) {
			// Strictly monotonic ts: the controller dedupes on type|id|runId|kind|ts.
			emitClock = Math.max(emitClock + 1, Date.now());
			fs.appendFileSync(outboxPath, `${JSON.stringify({ ...record, ts: new Date(emitClock).toISOString() })}\n`);
		},
		rotateOutbox() {
			session.emit({ type: "outbox_rotated" });
			fs.renameSync(outboxPath, `${outboxPath.replace(/\.jsonl$/, "")}.1.jsonl`);
		},
		readInboxCommands() {
			return fs
				.readdirSync(inboxDir)
				.filter((name) => name.endsWith(".json"))
				.sort()
				.map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(inboxDir, name), "utf8")) }));
		},
		async nextInboxCommand({ timeoutMs = 5000, consume = true } = {}) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const commands = session.readInboxCommands();
				if (commands.length > 0) {
					const [command] = commands;
					if (consume) fs.rmSync(path.join(inboxDir, command.name));
					return command;
				}
				if (Date.now() > deadline) throw new Error("no inbox command arrived in time");
				await sleep(25);
			}
		},
	};
	if ((options.heartbeat ?? "fresh") === "fresh") session.heartbeat({ busy: options.busy ?? false });
	else if (options.heartbeat === "stale") session.heartbeat({ ageMs: 60_000, busy: options.busy ?? false });
	return session;
}

export function runCtl(args, agentDir, { timeoutMs = 20_000 } = {}) {
	return runScript(CTL, args, { env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir }, timeoutMs });
}

export function runScript(script, args, { env = process.env, timeoutMs = 20_000, stdin = null } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args], { env });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${path.basename(script)} ${args.join(" ")} timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
		if (stdin !== null) child.stdin.write(stdin);
		child.stdin.end();
	});
}

// --- bridge-side world (imports the real extension module) -------------------

export function makeFakePi({ sendUserMessage, sendMessage, sessionName } = {}) {
	const handlers = new Map();
	const world = {
		sent: [],
		registered: new Map(),
		pi: {
			on(event, handler) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
			async sendUserMessage(message, options) {
				world.sent.push({ kind: "user", message, options });
				if (sendUserMessage) return sendUserMessage(message, options);
			},
			async sendMessage(message, options) {
				world.sent.push({ kind: "custom", message, options });
				if (sendMessage) return sendMessage(message, options);
			},
			getSessionName: () => sessionName ?? null,
			registerCommand(name, definition) {
				world.registered.set(name, definition);
			},
		},
		async fire(event, payload = {}, ctx = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
	};
	return world;
}

export function makeBridgeCtx({ sessionId, sessionFile = null, entries = [], isIdle } = {}) {
	const ctx = {
		hasUI: false,
		ui: { notify() {} },
		entries,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getEntries: () => ctx.entries,
		},
	};
	if (isIdle) ctx.isIdle = isIdle;
	return ctx;
}

export function readOutbox(sessionDir) {
	const file = path.join(sessionDir, "outbox.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

// Default derived from the bridge's INBOX_SAFETY_SCAN_MS (10 s) plus margin:
// when fs.watch misses a rename under load, the safety scan is the real
// worst-case delivery latency, and the wait must outlive it.
const BRIDGE_SAFETY_SCAN_MS = Number(
	fs
		.readFileSync(fileURLToPath(new URL("../atomic-extension/atomic-remote-bridge.ts", import.meta.url)), "utf8")
		.match(/INBOX_SAFETY_SCAN_MS = ([\d_]+)/)[1]
		.replaceAll("_", ""),
);

export async function untilOutbox(sessionDir, predicate, { timeoutMs = BRIDGE_SAFETY_SCAN_MS + 5000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const records = readOutbox(sessionDir);
		const match = records.find(predicate);
		if (match) return match;
		if (Date.now() > deadline) {
			throw new Error(`outbox record not found in time; outbox: ${JSON.stringify(records, null, 2)}`);
		}
		await sleep(25);
	}
}
