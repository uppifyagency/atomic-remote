---
description: List running Atomic sessions reachable via the atomic-remote bridge
---

List live Atomic bridge sessions by running this with the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/atomic-ctl.mjs" list
```

Report the sessions to the user (id, name, cwd). If none are found, explain that the bridge extension must be installed (`/atomic-remote:setup`) and the Atomic session reloaded with `/reload`.
