import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RPC_RUN, runScript } from "./helpers.mjs";

const FAKE_ATOMIC = fileURLToPath(new URL("./fixtures/fake-atomic.mjs", import.meta.url));

function runRpc(args, scenario) {
	return runScript(RPC_RUN, ["--atomic", FAKE_ATOMIC, ...args], {
		env: { ...process.env, FAKE_ATOMIC_SCENARIO: scenario },
	});
}

test("rpc-run: streams the assistant text and exits 0 on agent_end", async () => {
	const result = await runRpc(["say hello"], "reply");
	assert.equal(result.code, 0);
	assert.equal(result.stdout, "hello world\n");
});

test("rpc-run: a rejected prompt exits 1 immediately with the RPC error", async () => {
	const result = await runRpc(["anything"], "reject");
	assert.equal(result.code, 1);
	assert.match(result.stderr, /RPC error \(prompt\): no model configured/);
});

test("rpc-run: a silent session hits the timeout and exits 2", async () => {
	const result = await runRpc(["--timeout", "1", "never answered"], "hang");
	assert.equal(result.code, 2);
	assert.match(result.stderr, /Timeout after 1s/);
});

test("rpc-run: no prompt is a usage error", async () => {
	const result = await runRpc([], "reply");
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Usage/);
});

test("rpc-run: a non-numeric timeout is a usage error", async () => {
	const result = await runRpc(["--timeout", "soon", "prompt"], "reply");
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Usage/);
});

test("rpc-run: a missing atomic binary fails fast with a hint", async () => {
	const result = await runScript(RPC_RUN, ["--atomic", "/nonexistent/atomic", "hi"], {});
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Failed to start atomic/);
	assert.match(result.stderr, /ATOMIC_BIN/);
});
