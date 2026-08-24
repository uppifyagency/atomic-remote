#!/usr/bin/env node
/**
 * Installs the atomic-remote bridge extension into the Atomic extensions
 * directory (~/.atomic/agent/extensions/ by default, or ATOMIC_CODING_AGENT_DIR).
 *
 * After installing: inside the running Atomic session, run /reload
 * (or restart atomic). The bridge announces itself with a notification.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = process.env.ATOMIC_CODING_AGENT_DIR ?? path.join(os.homedir(), ".atomic", "agent");
const extensionsDir = path.join(agentDir, "extensions");
const source = fileURLToPath(new URL("../atomic-extension/atomic-remote-bridge.ts", import.meta.url));
const destination = path.join(extensionsDir, "atomic-remote-bridge.ts");

fs.mkdirSync(extensionsDir, { recursive: true });
fs.copyFileSync(source, destination);

console.log(`Installed: ${destination}`);
console.log("");
console.log("Next steps:");
console.log("  1. In the running Atomic terminal session, run /reload (or restart atomic).");
console.log('  2. You should see a notification: "atomic-remote bridge active (<id>)".');
console.log("  3. Optionally name the session inside Atomic: /remote-name worker");
console.log("  4. From Claude Code: /atomic-remote:list, then /atomic-remote:send");
