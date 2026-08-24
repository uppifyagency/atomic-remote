#!/usr/bin/env node
/**
 * rpc-run — one-shot headless Atomic run over the official RPC protocol
 * (see Atomic docs: rpc.md). Spawns `atomic --mode rpc --no-session`,
 * sends one prompt, streams the assistant text to stdout, exits on agent_end.
 *
 * Usage:
 *   rpc-run.mjs [--atomic <path-to-atomic>] [--model <provider/model>] [--timeout <s>] <prompt...>
 *
 * The atomic binary is resolved from --atomic, $ATOMIC_BIN, or PATH.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const args = process.argv.slice(2);
let atomicBin = process.env.ATOMIC_BIN ?? "atomic";
let model;
let timeoutMs = 600_000;
const promptParts = [];

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--atomic") atomicBin = args[++i];
	else if (args[i] === "--model") model = args[++i];
	else if (args[i] === "--timeout") timeoutMs = Number(args[++i]) * 1000;
	else promptParts.push(args[i]);
}

const prompt = promptParts.join(" ").trim();
if (!prompt) {
	console.error("Usage: rpc-run.mjs [--atomic <bin>] [--model <provider/model>] [--timeout <s>] <prompt...>");
	process.exit(1);
}

const atomicArgs = ["--mode", "rpc", "--no-session"];
if (model) atomicArgs.push("--model", model);

const child = spawn(atomicBin, atomicArgs, { stdio: ["pipe", "pipe", "inherit"] });

child.on("error", (error) => {
	console.error(`Failed to start atomic (${atomicBin}): ${error.message}`);
	console.error("Pass --atomic <path> or set ATOMIC_BIN if atomic is not on PATH.");
	process.exit(1);
});

const timer = setTimeout(() => {
	console.error(`\nTimeout after ${Math.round(timeoutMs / 1000)}s; aborting.`);
	try {
		child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
	} catch {}
	setTimeout(() => child.kill(), 1000);
	process.exitCode = 2;
}, timeoutMs);

// JSONL framing per Atomic RPC docs: split on \n only, strip trailing \r.
const decoder = new StringDecoder("utf8");
let buffer = "";
let printed = false;

function handleLine(line) {
	if (!line) return;
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
		printed = true;
		process.stdout.write(event.assistantMessageEvent.delta);
	}
	if (event.type === "response" && event.success === false) {
		console.error(`\nRPC error (${event.command}): ${event.error}`);
	}
	if (event.type === "agent_end") {
		if (printed) process.stdout.write("\n");
		clearTimeout(timer);
		child.kill();
		process.exit(0);
	}
}

child.stdout.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	let index;
	while ((index = buffer.indexOf("\n")) !== -1) {
		let line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		handleLine(line);
	}
});

child.on("exit", (code) => {
	clearTimeout(timer);
	if (process.exitCode === undefined && code !== 0) process.exitCode = code ?? 1;
});

child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
