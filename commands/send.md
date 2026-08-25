---
description: Send a command to a running Atomic session and optionally wait for its attributed reply
argument-hint: <target|auto> <message> [--mode steer|follow_up] [--wait]
---

The user wants to command a running Atomic session. Their arguments: $ARGUMENTS

Run the controller with the Bash tool, quoting the message as ONE argument (use
`--message-file` or stdin `-` for multi-line text — never argv joining):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" send <target> "<message>" [--mode <mode>] [--wait] [--idle-timeout <seconds>]
```

Rules:
- No target given → use `auto` (only works with exactly one live session; on exit 4 show the candidates).
- Default mode `prompt`. `--mode steer` redirects mid-run; `--mode follow_up` queues for after. Do NOT use `interrupt` here — that is `/atomic-remote:interrupt`.
- Add `--wait` when the user wants the answer. Exit codes are the contract: 0 = stdout is the attributed reply; 2 = still working, check later with `tail` (do not resend); 6 = concurrent user input, report nothing as Atomic's reply; 7 = a workflow keeps running detached, report the printed run id. Relay results faithfully.
- When the task has acceptance criteria or file references, hand it off as structure: write `{goal, constraints, acceptance, context: {files}}` to a JSON file and add `--plan <file>` (prompt/follow_up only, bridge protocol 3).
- `--mode command` dispatches a leading-slash message as a real Atomic slash command; `--json` with `--wait` prints the structured outcome object instead of bare text.
