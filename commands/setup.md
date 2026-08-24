---
description: Install the atomic-remote bridge extension into ~/.atomic/agent/extensions/
---

Install the Atomic-side bridge extension by running this with the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-bridge.mjs"
```

Then tell the user, in their language, that they must run `/reload` inside the running Atomic terminal session (or restart `atomic`) to activate the bridge, and that they can optionally name the session with `/remote-name <name>` inside Atomic for easier targeting.
