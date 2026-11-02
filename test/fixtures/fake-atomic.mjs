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
		send({ type: "agent_settled", aborted: true });
		return;
	}
	if (event.type !== "prompt") return;
	const text = (delta) => send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
	const accepted = (disposition) =>
		send({ type: "response", command: "prompt", success: true, data: { disposition } });
	switch (scenario) {
		case "reply":
			accepted("started");
			text("hello ");
			text("world");
			send({ type: "agent_end" });
			send({ type: "agent_settled", aborted: false });
			break;
		case "retry":
			accepted("started");
			text("first try ");
			send({ type: "agent_end" });
			setTimeout(() => {
				text("after retry");
				send({ type: "agent_end" });
				send({ type: "agent_settled", aborted: false });
			}, 200);
			break;
		case "handled":
			accepted("handled");
			break;
		case "reject":
			send({ type: "response", command: "prompt", success: false, error: "no model configured" });
			break;
		case "hang":
			break;
		default:
			send({ type: "agent_end" });
			send({ type: "agent_settled", aborted: false });
	}
});
