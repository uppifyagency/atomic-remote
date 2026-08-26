import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakePi, makeBridgeCtx, readOutbox, untilOutbox, sleep } from "./helpers.mjs";

// Expiry of unclaimed attribution state (ROADMAP item 1). node --test runs
// each file in its own process, so the tiny TTLs below cannot leak into the
// other bridge suites.
process.env.ATOMIC_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-ttl-test-"));
process.env.ATOMIC_REMOTE_RELOAD_SETTLE_MS = "100";
process.env.ATOMIC_REMOTE_BINDING_TTL_MS = "150";
process.env.ATOMIC_REMOTE_LAUNCH_TTL_MS = "150";
process.env.ATOMIC_REMOTE_OUTBOX_MAX_BYTES = "600";
const bridgeRoot = path.join(process.env.ATOMIC_CODING_AGENT_DIR, "remote-bridge");
const { default: registerBridge } = await import("../atomic-extension/atomic-remote-bridge.ts");

let bootSeq = 0;

async function boot(t, { cwd } = {}) {
	const sessionId = `ttl-${String(bootSeq++).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
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
	return {
		world,
		ctx,
		dir,
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

test("an unclaimed binding expires loudly and cannot claim a later identical turn", async (t) => {
	const b = await boot(t);
	b.drop({ id: "stale-bind", action: "prompt", message: "recurring text" });
	await b.until((r) => r.type === "accepted" && r.id === "stale-bind");
	await sleep(300); // past BINDING_TTL_MS
	await b.world.fire("agent_start", {}, b.ctx); // sweep trigger
	// A non-error record: a queued follow_up can legitimately outlive the TTL
	// (input timing at delivery is undocumented), so expiry must never kill a
	// live --wait with a spurious exit 5. It only prevents future capture.
	const expired = b.records().find((r) => r.type === "binding_expired");
	assert.equal(expired?.id, "stale-bind", "expiry must name the abandoned command");
	assert.equal(expired?.reason, "ttl");
	assert.equal(
		b.records().some((r) => r.type === "error" && r.id === "stale-bind"),
		false,
		"expiry must not be an error record: it would fail a possibly-live --wait",
	);

	await b.world.fire("input", { source: "extension", text: "recurring text" });
	assert.equal(
		b.records().filter((r) => r.type === "turn_bound").length,
		0,
		"an expired binding must not claim a future identical injection",
	);
});

test("an armed workflow launch expires loudly when no started notice ever arrives", async (t) => {
	const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-remote-wf-"));
	const b = await boot(t, { cwd: targetCwd });
	b.drop({
		id: "stale-launch",
		action: "run_workflow",
		workflowName: "never-starts",
		workflowSource: 'export default workflow({ name: "never-starts" });\n',
	});
	await b.until((r) => r.type === "accepted" && r.id === "stale-launch");
	await sleep(300); // past LAUNCH_TTL_MS
	await b.world.fire("agent_start", {}, b.ctx); // sweep trigger
	// Non-error for the same reason as bindings: a cold-start admission (first
	// workflow action initializes the durable backend) can be legitimately slow.
	const expired = b.records().find((r) => r.type === "workflow_launch_expired");
	assert.equal(expired?.id, "stale-launch");
	assert.equal(expired?.workflowName, "never-starts");
	assert.equal(
		b.records().some((r) => r.type === "error" && r.id === "stale-launch"),
		false,
		"launch expiry must not fail a possibly-live --wait",
	);

	// A later same-named run (user relaunch) must not inherit the dead owner.
	b.ctx.entries.push({
		type: "custom_message",
		customType: "workflows:lifecycle-notice",
		id: "e-ttl-1",
		content: "Workflow never-starts started",
		details: {
			kind: "started",
			scope: "run",
			runId: "2b2b2b2b-abcd-4ef0-9876-666677778888",
			workflowName: "never-starts",
			status: "running",
		},
	});
	await b.world.fire("agent_start", {}, b.ctx);
	const lifecycle = b.records().find((r) => r.type === "workflow_lifecycle" && r.kind === "started");
	assert.equal(lifecycle?.owner, null);
	assert.equal(
		b.records().filter((r) => r.type === "workflow_started" && r.owner === "stale-launch").length,
		0,
	);
});

test("review: a real rotation writes an outbox_rotated record that carries seq", async (t) => {
	const b = await boot(t);
	// OUTBOX_MAX_BYTES is 600 in this file: a few pings push the outbox past it
	// and the next emit rotates for real.
	for (let i = 0; i < 8; i++) {
		b.drop({ id: `rot-${i}`, action: "ping" });
		await b.until((r) => r.type === "pong" && r.id === `rot-${i}`);
	}
	const rotated = fs.readFileSync(path.join(b.dir, "outbox.1.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	const marker = rotated.at(-1);
	assert.equal(marker.type, "outbox_rotated", "the old generation must end with the rotation marker");
	assert.equal(typeof marker.seq, "number", "every record carries seq, the rotation marker included");
	assert.ok(b.records().every((r) => typeof r.seq === "number"));
});
