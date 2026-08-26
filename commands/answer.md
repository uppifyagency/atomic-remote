---
description: Unblock an Atomic workflow run that is waiting for human input
argument-hint: "<target> <run-id> <answer...>"
---

Answer a workflow run that is paused on a human question in the target Atomic session.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" answer $ARGUMENTS
```

- The run id must be the full 36-character UUID (as printed by exit-7 messages,
  `outcome`, or `status` with a statusFile-enabled project).
- The controller injects a `follow_up` that instructs the agent to deliver the
  answer through the workflow tool (`send` with `delivery: "answer"`). It costs
  one agent turn.
- Add `--wait` to wait for the attributed confirmation.
- Detect waiting runs first: exit 7 from `send --wait`/`run-workflow --wait`
  names them when the project has `statusFile: true`, and `outcome` marks them
  with `awaitingInput: true`.
