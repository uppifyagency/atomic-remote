---
description: Abort an Atomic session's current turn and redirect it to a new instruction (destructive to in-flight work)
argument-hint: <target|auto> <new instruction>
---

The user explicitly wants to interrupt a running Atomic session. Their arguments: $ARGUMENTS

This aborts Atomic's current turn — in-flight work is discarded. Only proceed because the
user invoked this command explicitly. Run with the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" send <target> "<new instruction>" --mode interrupt --wait
```

If the user gave no replacement instruction and just wants Atomic to STOP, use:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" abort <target>
```

Relay the outcome faithfully (exit 0 = attributed reply on stdout).
