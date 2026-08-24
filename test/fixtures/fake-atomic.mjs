#!/usr/bin/env node
// Stands in for `atomic --mode rpc`: speaks just enough of the JSONL RPC
// protocol for rpc-run tests. Behavior is selected by FAKE_ATOMIC_SCENARIO.

import readline from "node:readline";

const scenario = process.env.FAKE_ATOMIC_SCENARIO ?? "reply";
const rl = readline.createInterface({ input: process.stdin });

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

rl.on("line", (line) => {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "abort") {
		send({ type: "agent_end" });
		return;
	}
	if (event.type !== "prompt") return;
	switch (scenario) {
		case "reply":
			send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
			send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
			send({ type: "agent_end" });
			break;
		case "reject":
			send({ type: "response", command: "prompt", success: false, error: "no model configured" });
			break;
		case "hang":
			break;
		default:
			send({ type: "agent_end" });
	}
});
