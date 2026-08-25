---
description: Query the result of a past atomic-remote command from outbox history (safe to poll, works on closed sessions)
argument-hint: <target> <command-id>
---

The user wants the result of a previously sent atomic-remote command. Their arguments: $ARGUMENTS

Run the controller with the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" outcome <target> <command-id>
```

Rules:
- The command id is printed by `send` and `run-workflow` ("command id ..."); this replays outbox history through the same state machine `--wait` uses, so the answers cannot disagree.
- Read `state` from the JSON: `completed` (report `text` as Atomic's reply), `working`/`pending` (still going, poll later, do NOT resend), `detached` (workflow still running, report `runId`), `failed` (report `text`; if `failedStageId` is present, a replan can target that stage), `aborted`, `uncertain` (report nothing as Atomic's reply).
- Exit 4 means no outbox record mentions that command id in that session: re-check the id and the target before anything else.
