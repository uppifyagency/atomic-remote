import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("the version is the same in plugin.json, the bridge, the README badge, and the changelog", () => {
	const plugin = JSON.parse(read(".claude-plugin/plugin.json")).version;
	const bridge = read("atomic-extension/atomic-remote-bridge.ts").match(/BRIDGE_VERSION = "([^"]+)"/)[1];
	const badge = read("README.md").match(/badge\/version-([0-9.]+)-/)[1];
	const changelog = read("CHANGELOG.md").match(/^## \[([0-9.]+)\]/m)[1];
	assert.equal(bridge, plugin, "bridge BRIDGE_VERSION vs plugin.json");
	assert.equal(badge, plugin, "README version badge vs plugin.json");
	assert.equal(changelog, plugin, "latest CHANGELOG section vs plugin.json");
});

test("every controller flag the docs teach actually exists", () => {
	const ctlSource = read("scripts/atomic-ctl.mjs");
	const ctlFlags = new Set([...ctlSource.matchAll(/"(--[a-z-]+)":/g)].map((m) => m[1]));
	const rpcFlags = new Set(["--atomic", "--model", "--timeout"]);
	// Flags of the atomic binary itself, mentioned when describing what rpc-run spawns,
	// and node's own --test from the README test instructions.
	const atomicBinaryFlags = new Set(["--mode", "--no-session", "--test"]);
	const docs = [
		"README.md",
		"skills/atomic-remote/SKILL.md",
		...fs.readdirSync(path.join(root, "commands")).map((name) => `commands/${name}`),
	];
	for (const doc of docs) {
		const mentioned = new Set([...read(doc).matchAll(/(--[a-z][a-z-]+)/g)].map((m) => m[1]));
		for (const flag of mentioned) {
			assert.ok(
				ctlFlags.has(flag) || rpcFlags.has(flag) || atomicBinaryFlags.has(flag) || flag === "--help",
				`${doc} documents ${flag}, which no script accepts`,
			);
		}
	}
});

test("every exit code the controller can produce is documented in the skill and README", () => {
	const codes = ["0", "2", "3", "4", "5", "6", "7"];
	for (const doc of ["README.md", "skills/atomic-remote/SKILL.md"]) {
		const content = read(doc);
		for (const code of codes) {
			assert.ok(new RegExp(`\\|\\s*${code}\\s*\\|`).test(content), `${doc} is missing an exit-code table row for ${code}`);
		}
	}
});
