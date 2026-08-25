---
name: atomic-remote
description: Command a running Atomic (by Bastani) terminal session from Claude Code — send prompts, steer or interrupt it, track its workflows, wait for attributed replies — or run Atomic headless via RPC. Use when the user asks to control, command, delegate to, or coordinate with Atomic.
---

# atomic-remote — commanding Atomic from Claude Code

Two control planes. Pick by situation:

| Situation | Use |
|---|---|
| The user has an Atomic session open in a terminal | **Bridge** (`atomic-ctl.mjs`) |
| No session is open; a one-shot run is needed | **RPC** (`rpc-run.mjs`) |

## Bridge workflow (protocol v3)

1. **Discover**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" list`
   States: `live` (commandable), `stale` (bridge v1 or hung — needs `/reload` in Atomic),
   `closed` (history only). Live sessions also show `busy` or `idle` (from the 5 s
   heartbeat). Targets: name (auto = cwd basename, or `/remote-name`), session-id prefix,
   cwd, or `auto` when exactly one live session exists.

2. **Check before commanding** (imperative rule): before a `send --wait`, run
   `status <target>` (`list` already hints busy/idle; `status` is the authoritative
   bridge-side answer). If `idle: false`, or the later `accepted` record reports
   `contended: true`, do NOT trust attribution blindly — prefer `follow` to watch,
   or `--mode steer` to cooperate with the running work instead of racing it.

3. **Send**:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" send auto "Run the tests and fix failures" --wait
   ```
   - Multi-line prompts: `--message-file <path>` or pipe to `send <target> -` (stdin).
     Never rely on argv joining for multi-line text.
   - Modes: `prompt` (default), `steer` (redirect mid-run), `follow_up` (queue for after),
     `interrupt` (aborts current turn — only on explicit user request; prefer the
     dedicated `/atomic-remote:interrupt` command).
   - Long tasks: raise `--idle-timeout` (resets on any bridge activity) rather than
     setting a huge absolute `--timeout`.
   - `--accept-partial` opts into a reply contaminated by concurrent user input
     (turns exit 6 into exit 0 with a warning); `-v`/`--verbose` traces bridge
     records on stderr.
   - **Hand off a plan as structure, not prose**: write the plan to a JSON file
     (`goal`, `constraints`, `acceptance`, `context.files`; ≤ 8 KiB) and attach it
     with `--plan plan.json` (prompt/follow_up only). The bridge persists it in the
     session's `plans/` directory and inlines it in the injected message. Prefer
     this over pasting a plan into the message body whenever the task has
     acceptance criteria or file references.
   - `--mode command` dispatches a leading-slash message (e.g. `/workflow reload`)
     as a real Atomic slash command. Plain `prompt` sends slash text as chat the
     model may ignore.
   - `--json` on `send --wait` prints the structured outcome object (same shape as
     the `outcome` command) instead of the bare reply text.

3b. **Multi-stage plans — privileged path**: generate a workflow TS file
   (`export default workflow({ name, inputs, outputs, run })`) and run it
   deterministically:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" run-workflow auto ./my-plan.ts --args "target=main" --wait
   ```
   This installs the file into the session's `.atomic/workflows/`, injects
   `/workflow reload` then `/workflow run <name>`, and binds attribution to the
   run. `--name <n>` overrides the name (default: file basename, `[a-z0-9-]`).
   A `workflow_installed` record with `overwrote: true` means an existing
   workflow file was replaced — mention that to the user.

3c. **Query outcomes after the fact** (the replan loop): any command id can be
   interrogated later, even after a timeout or on a closed session:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" outcome <target> <command-id>
   ```
   JSON answer: `state` is `pending|working|completed|failed|aborted|uncertain|detached`,
   plus reply `text`, `runs` (with `failedStageId`/`stageName` when a workflow
   failed), and `planPath`. After exit 2 or 7 from `send --wait`, poll `outcome`
   instead of resending; on `state: "failed"` with a `failedStageId`, replan
   from that stage instead of restarting the whole task.

4. **Read the outcome — exit codes are the contract** (do not improvise):

   | Exit | Meaning | What YOU do |
   |---|---|---|
   | 0 | stdout is the attributed reply | Report it as Atomic's answer |
   | 1 | Usage error (unknown flag, bad arguments) | Fix the command line; do NOT retry it unchanged |
   | 2 | Timeout, session may still be working | Re-check later with `tail`; do NOT resend the prompt |
   | 3 | No session recorded / delivery refused (stale heartbeat) | Tell the user to `/reload` in Atomic (or run setup) |
   | 4 | Target not found or ambiguous | Fix the target: show the listed candidates, pick or ask — do NOT suggest reinstalling |
   | 5 | Bridge/run error (incl. failed workflow) | Report the error verbatim |
   | 6 | Attribution uncertain (user typed concurrently) | Report NOTHING as Atomic's reply; inspect with `tail` |
   | 7 | Workflow still running detached (run id printed) | Report the run id and that work continues; check later with `follow`/`tail` — do NOT present intermediate text as the result |

5. **Workflows**: if the command makes Atomic launch a workflow, `--wait` follows it to
   its terminal notice (`workflow_lifecycle` records). Never present "Workflow started"
   text as a final result — that is exactly the failure mode the protocol exists to prevent.

6. **Observe live**: `follow <target>` streams outbox records (one JSON per line;
   bounded, 30 s by default — `--for <s>` to change, `--for 0` to stream forever);
   `tail <target> --lines 30` shows recent history. Both work on stale/closed
   sessions too — history survives session shutdown.

## Troubleshooting

- `list` empty → bridge not installed/loaded: run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-bridge.mjs"`, then the user runs `/reload`
  inside Atomic.
- Session `stale` but visibly open in the terminal → it runs bridge v1 in memory:
  `/reload` upgrades it in place.
- `atomic` not on PATH (nvm installs) → `zsh -ic 'which atomic'`; pass `--atomic <path>`
  or set `ATOMIC_BIN` for `rpc-run.mjs`. Atomic requires Node ≥ 22.

## RPC: headless one-shot

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/rpc-run.mjs" --atomic "$HOME/.nvm/versions/node/v22.22.1/bin/atomic" "Summarize failing tests"
```

Spawns a NEW `atomic --mode rpc --no-session` in the current cwd; streams text; exits on
`agent_end`. It does not touch the user's open terminal session.

## Security

The inbox is arbitrary command execution with the user's permissions. Never widen the
0700/0600 modes, never expose the inbox over a network, never build auto-forwarders into it.
