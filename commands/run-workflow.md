---
description: Install a generated workflow TS into a running Atomic session and run it deterministically
argument-hint: <target|auto> <file.ts> [--name <name>] [--args "<args>"] [--wait]
---

The user wants a running Atomic session to execute a multi-stage workflow. Their arguments: $ARGUMENTS

Run the controller with the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" run-workflow <target> <file.ts> [--name <name>] [--args "<args>"] [--wait] [--json]
```

Rules:
- The file must export `default workflow({ name, ... })`; the installed name defaults to the file basename (`[a-z0-9-]{1,64}`), override with `--name`.
- This installs the file into the session's `.atomic/workflows/`, injects `/workflow reload`, then `/workflow run <name>`. If the output mentions an overwrite (`workflow_installed` with `overwrote: true`), tell the user an existing workflow file was replaced.
- Requires bridge protocol 3: on the upgrade hint (exit 5), run `/atomic-remote:setup` and ask the user to `/reload` inside Atomic.
- With `--wait`, exit codes are the contract (0 reply, 2 still working, 5 run failed, 7 detached run id printed). After exit 2 or 7, query later with `outcome <target> <command-id>` instead of resending.
