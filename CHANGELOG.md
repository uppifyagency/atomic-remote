# Changelog

## [0.2.0] — 2026-08-24

Protocol v2. Result of an adversarial multi-agent design review (30 proposals,
API-verified against Atomic's official docs, distilled to a 5-item roadmap —
see `ROADMAP.md`). All five items shipped:

### Added
- **Heartbeat liveness** — bridge writes `heartbeat.json` every 5 s; the controller
  reports `live` / `stale` / `closed` states instead of guessing from a transient
  engine pid. Delivery is refused to sessions with a stale heartbeat.
- **Command attribution** — commands are bound to their turn via the documented
  `input` event (`source: "extension"`); every agent record carries an `owner`
  command id; `--wait` concludes on `agent_settled` (the documented terminal
  event), never on the first `agent_end`. Concurrent user input aborts
  attribution explicitly (exit 6) instead of returning someone else's answer.
- **Workflow tracking** — workflow launches are detected via `tool_execution_end`,
  lifecycle notices are mirrored as `workflow_started` / `workflow_lifecycle`
  records, and `--wait` follows detached runs to their terminal notice instead
  of printing "Workflow started" as the result.
- **New actions**: `status` (idle/busy, pending workflows, protocol) and `abort`.
- **New subcommands**: `status`, `follow` (live outbox stream), `abort`,
  `prune` (explicit, closed-sessions-only).
- **Exit-code taxonomy**: 0 ok · 2 timeout · 3 no session · 4 ambiguous ·
  5 bridge/run error · 6 attribution uncertain · 7 async work detached.
- **Protocol handshake** — `bridge_ready`/`pong` carry `protocol` and
  `bridgeVersion`; the controller refuses protocol < 2 with a fix hint.
- `--message-file` and `-` (stdin) preserve multi-line prompts verbatim.

### Changed
- Session directories are keyed by the **stable session id**, not a pid; `/reload`
  keeps the same identity and targets stay valid.
- Session names default to the cwd basename and follow `/name` via
  `session_info_changed`; `/remote-name` still overrides.
- Inbox ingestion is fail-closed: schema validation (typed reject reasons),
  `O_NOFOLLOW` + regular-file check + 64 KiB cap, serial processing in filename
  order, at-least-once via `.processing` rename markers.
- Outbox files are `0600`, rotated at 8 MiB.
- Double timeout: `--idle-timeout` (default 120 s, resets on any bridge activity)
  plus optional absolute `--timeout`.

### Fixed
- **`list` no longer deletes anything.** v1 pruned session directories based on a
  dead engine pid — which Atomic legitimately replaces — destroying live sessions'
  history during a read-only command.
- `session_shutdown` no longer erases the outbox: history survives; only the
  inbox (replay vector) is cleared; `bridge_closed` marks the reason.
- Rewind-safe outbox reader: rotation/truncation no longer silently yields zero
  records forever.
- Unknown CLI flags are rejected instead of being forwarded into the prompt.

## [0.1.0] — 2026-08-16

Initial release: file-based bridge (inbox/outbox), `list` / `ping` / `send` /
`tail`, modes `prompt` / `steer` / `follow_up` / `interrupt`, headless one-shot
RPC runner, Claude Code slash commands and skill.
