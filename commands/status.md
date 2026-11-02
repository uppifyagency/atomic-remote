---
description: Show whether a running Atomic session is idle or busy, and its pending workflows
argument-hint: [target|auto]
---

Query the Atomic session's bridge status with the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" status <target-or-auto>
```

Report to the user: idle/busy, pending workflow run ids, session name, bridge version.
If exit code is 3, the session is not live — suggest `/reload` inside Atomic or `/atomic-remote:setup`.

Options:
- `--commands` also lists the session's slash-command surface (what
  `send --mode command` may dispatch).
- `awaitingInput` lists runs whose stage is waiting on a human; unblock them
  with `/atomic-remote:answer`. When the project enables `statusFile: true` in
  its workflow config, the report also gains a `workflowStatus` section with
  the question text.
