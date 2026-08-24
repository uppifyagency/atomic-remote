---
description: Stream live bridge events from a running Atomic session (what it's doing right now)
argument-hint: [target|auto] [seconds]
---

Stream the Atomic session's outbox with the Bash tool (bounded — 30 seconds by default;
pass `--for <seconds>` for longer, `--for 0` streams forever):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" follow <target-or-auto> --for <seconds>
```

Then summarize for the user what happened: turns started/settled, owners, workflow
lifecycle records. For a static snapshot instead, use:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" tail <target-or-auto> --lines 30
```
