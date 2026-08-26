# Changelog

## [0.3.1] - 2026-08-26

Attribution hardening, human-in-the-loop visibility, and honest replay
(ROADMAP TOP 5). The protocol stays 3: every addition (`seq`,
`workflow_heartbeat`, `include`, the `answer` command) is additive, and v2/v3.0
sessions keep working unchanged.

### Added
- **Human-in-the-loop visibility and unblock** — a workflow run paused on a
  human question produces no main-chat notice by design, so it used to look
  like "still working". Now: `status` merges a `workflowStatus` section read
  from the project's `.atomic/workflows/status.json` (when the project enables
  `statusFile: true`), exit-7 messages name run(s) `awaiting human input` and
  the unblock path, `outcome`/`--json` snapshots mark those runs with
  `awaitingInput: true`, and the new `answer <target> <run-id> <text>` command
  injects a follow_up instructing the agent to deliver the answer via the
  workflow tool (`send` with `delivery: "answer"`). New
  `/atomic-remote:answer` command doc.
- **Workflow heartbeat mirroring** — `workflows:workflow-heartbeat` cards are
  mirrored as `workflow_heartbeat` records (at most one per run per heartbeat
  interval, 15 min default), so a long silent run keeps resetting
  `--idle-timeout` instead of timing out as "stuck".
- **Verified command surface** — `send --mode command` now validates the slash
  name against `pi.getCommands()`: an unknown command is refused with the
  available names (first 20) instead of degrading to chat text the model may
  ignore. `status --commands` (bridge: `include: ["commands"]`) lists the
  session's slash-command surface. Hosts without `getCommands` stay permissive.
- **Total order on the outbox** — every record now carries a strictly
  increasing `seq`. Readers dedupe on it (two same-millisecond `foreign_input`
  records no longer collapse); records from older bridges fall back to the
  composite key.
- **`interruptAbortMessage`** — a remote interrupt now replaces the generic
  abort result in the model's context with
  `interrupted by atomic-remote command <id>`, so the transcript says why the
  turn died.

### Changed
- **Two-lane command queue** — `ping`/`status`/`abort` are handled immediately
  instead of queued behind injection commands; previously a `run_workflow`'s
  5 s reload settle (and anything else on the serial chain) delayed them past
  the controller's 10 s round-trip timeout. Injection commands stay strictly
  serial.
- **`tail` reads the rotated generation** (`outbox.1.jsonl`) like `outcome`
  always did; history no longer vanishes from `tail` at the 8 MiB rotation.
- **`outcome` replays honestly** — the reducer derives prompt-ness from the
  action the `accepted` record carries instead of a hardcoded `"prompt"`: a
  completed steer/follow_up now replays as `completed` (was `working`/exit 2)
  and innocuous foreign input no longer poisons non-prompt replays into
  `uncertain`. The replay also dedupes records with the reader's key.
- **Durable entry cursor** — the workflow mirror persists the last scanned
  entry id in `meta.json` (`lastEntryId`); a `/reload` resumes the scan instead
  of re-emitting the whole mirrored history into the outbox. In-flight runs are
  persisted alongside the cursor (`pendingRuns`) and rebuilt by the fresh
  instance, so a reload mid-run neither empties `pendingWorkflows` nor lets a
  wait settle non-provisionally while the run is still alive (found in review).
- **Slash names from `getCommands()` are normalized** — a leading `/` in an
  advertised name no longer makes a valid `--mode command` dispatch look
  unknown (found in review).
- **`status --commands` against a pre-0.3.1 bridge warns** — when the report
  comes back without a `commands` field the controller says the bridge ignores
  `include` and suggests setup + `/reload`, instead of silently printing a
  report that looks complete (found in review).
- **Delivery guard** — the controller re-reads `meta.json` at write time and
  refuses (exit 3) a session marked `closed`, instead of recreating an inbox
  nobody will ever read while its heartbeat still looks fresh.

### Fixed
- **`pendingWorkflowLaunch` could not be disarmed** (attribution leak,
  worst-in-class): it survived `/new`, `/resume`, `/fork` and failed launch
  injections, so the next same-named run — even one the user launched by
  hand — was attributed to a dead command. Now: cleared on session switch,
  cleared when the launch injection throws, and expired after 60 s with a
  typed `workflow_launch_expired` record naming the command.
- **Unclaimed text bindings lived forever**: a binding whose injection never
  produced an `input` event (e.g. a handled slash command) could capture a
  future identical turn. Bindings now expire after 10 min and the table is
  capped at 32 (oldest evicted); both paths emit a typed `binding_expired`
  record (`reason: "ttl" | "evicted"`). Deliberately not an `error`: a queued
  follow_up can legitimately outlive the TTL, and failing a possibly-live
  `--wait` with a spurious exit 5 would be worse than the old hang. The
  armed-launch expiry (`workflow_launch_expired`) is a non-error note for the
  same reason (a cold-start admission can be slow); both still disarm the
  state, which is what prevents the misattribution.
- **Preemption misattribution window**: when the aborted run's late
  `agent_end` landed after the interrupt's `agent_start`, the aborted settle
  was attributed to the interrupt owner (exit 0 on someone else's text). The
  settle now also checks the engine's own `isIdle()`: a settle arriving while
  the engine is still busy belongs to the preempted run.
- Doc drift: `atomic-ctl` header/usage and the bridge header said "v2", the
  README said `bridge v0.2.1 active` and "protocol v2". All track 0.3.1/v3
  now, and the consistency suite pins these strings so the drift is a failing
  test next time.

## [0.3.0] - 2026-08-25

Protocol v3: the plan→execution handoff carries structure instead of prose, and
execution feedback flows back typed and queryable.

### Added
- **Structured plan handoff** — `send --plan <plan.json>` attaches a plan artifact
  (goal, constraints, acceptance criteria, file references; ≤ 8 KiB) to a
  `prompt`/`follow_up`. The bridge persists it at
  `remote-bridge/<sid>/plans/<command-id>.json` and inlines it in the injected
  message; `accepted` records carry `planPath`.
- **Deterministic workflow entry** — new `run-workflow <target> <file.ts>
  [--name <n>] [--args "<a>"]` controller command and `run_workflow` bridge action
  (command files up to 256 KiB): installs the workflow TS into the session's
  `.atomic/workflows/`, injects `/workflow reload` then `/workflow <name>`,
  binds attribution to the run injection, and reports overwrites
  (`workflow_installed` with `overwrote`).
- **Slash-command dispatch** — `send --mode command "/…"` (bridge action
  `command`) injects with `expandPromptTemplates: true`, so the text dispatches
  as a real slash command instead of chat the model may or may not obey.
- **Queryable outcomes** — new `outcome <target> <command-id> [--json]` command
  replays outbox history (rotated file included, closed sessions included)
  through the same state machine `--wait` runs live and prints JSON with
  `state` (`pending|working|completed|failed|aborted|uncertain|detached`),
  reply text, runs, and `failedStageId`. `send --wait --json` and
  `run-workflow --wait --json` print the same object, exit codes unchanged.

- **Test suite** (`node --test 'test/*.test.mjs'`, Node ≥ 22, zero dependencies): 72 tests
  covering the controller end-to-end (target resolution, exit-code contract,
  wait-loop state machine, outbox rotation, reattach, prune safety), the bridge
  extension imported as a real module (validation matrix, serial ingestion,
  crash recovery, attribution, workflow mirroring, shutdown semantics), rpc-run
  against a scripted fake `atomic`, and repo consistency (version sync,
  documented flags/exit codes must exist).
- **`list` shows busy/idle** for live sessions, from the heartbeat the bridge
  already writes; `list --json` carries a `busy` field. Answering "is it safe
  to send?" no longer requires a `status` round-trip.

### Changed
- **Workflow feedback is typed.** The bridge mirrors the workflow engine's own
  lifecycle notices (`custom_message` entries, `customType
  "workflows:lifecycle-notice"`): `workflow_lifecycle` records now carry
  `scope` (`run`/`stage`), `workflowName`, `status`, and stage fields
  (`stageId`, `stageName`, `failedStageId`, `error`). `terminal` is true only
  for run-scope terminal kinds, so a stage completing cannot end a run-level
  wait. The v2 keyword regex over serialized entries is gone, with its false
  negatives (exit-7 timeouts) and false positives (assistant text quoting a
  run id near "completed"). `workflow_started` now reads the workflow tool's
  structured `result.details.runId` instead of regex-matching a UUID.
- **Protocol bumped to 3** (`BRIDGE_VERSION` 0.3.0). The controller still
  delivers v2-shaped commands to protocol-2 sessions; only the v3 features
  (`--plan`, `--mode command`, `run-workflow`) are refused client-side, before
  touching the inbox, with the setup + `/reload` hint.
- **`list` human output gained a column**: busy/idle sits between the state
  and `name=`. Anything parsing the plain-text columns positionally must
  adjust; `list --json` remains the stable machine surface.
- **`prune` now also reclaims long-stale sessions.** Crashed and v1 bridges
  never reach `status: "closed"`, so their dirs used to leak forever. A stale
  session whose last heartbeat is older than `--older-than` is now pruned;
  live sessions are still never touched, and cleanup still happens only via
  the explicit `prune` command.

### Fixed
- **`status` can no longer report `idle: true` and `busy: true` at once**
  (observed live). Both fields, the heartbeat `busy` flag, and `accepted.contended`
  now derive from one source of truth: the engine's `isIdle()` when available,
  the bridge's own turn tracking only as fallback.
- **Interrupt replies are now attributed** (reproduced live, twice, on
  atomic 0.9.13). On a busy session, the interrupt's new turn used to start
  while the old command was still bound: the aborted run's late settle
  consumed the old owner with `text: null`, destroyed the interrupt binding,
  and the actual reply landed `owner: null` — so `send --mode interrupt
  --wait` timed out (exit 2) while the reply sat ownerless in the outbox.
  The bridge now treats an interrupt as preemption: the interrupt claims the
  next turn even over a bound owner (`turn_bound` with `via: "interrupt"`),
  and the preempted command's settle is emitted with `aborted: true` under
  its own id. The controller reports an owned aborted settle as exit 5
  ("aborted before completing") instead of a silent empty success.
- **`prune` now ages closed sessions by `closedAt`, not `startedAt`.** A
  long-lived session closed an hour ago no longer loses its entire history to
  a default 7-day prune just because it *started* more than 7 days ago.
- **Documented exit code 1 (usage error)** in the README and skill exit-code
  tables, and documented `--accept-partial` and `-v`/`--verbose`; a
  consistency test now derives the exit-code taxonomy from the source and
  checks both docs→code and code→docs flag coverage.

## [0.2.1] — 2026-08-24

Hardening release: every fix below comes from a fresh 8-finder adversarial code
review of protocol v2 (18 verified findings), each verified against a live session.

### Fixed
- **Bridge: per-session state is now reset on `session_start`.** After `/new`,
  `/resume`, or `/fork` in the same engine process, stale attribution bindings,
  workflow runs, and the entry cursor no longer leak into the new session.
- **Bridge: user input no longer erases a bound owner.** If the user types into
  the session mid-turn, the settle keeps its `owner` and carries
  `foreignInputSeen: true`; the controller now honors the documented exit 6
  (attribution uncertain) instead of silently timing out (exit 2) and dropping
  the reply. `--accept-partial` still opts into the contaminated reply.
- **Bridge: stale interrupt bindings are cleared on settle** — a pending
  interrupt binding can no longer claim a later, unrelated turn.
- **Bridge: automatic GC of closed sessions removed.** "Nothing is deleted
  implicitly" is now literally true; cleanup happens only via explicit `prune`.
- **Bridge: restart-recovery error records now carry the real command id**
  (the filename pattern was captured wrong, so recovery errors never correlated).
- **Outbox rotation no longer loses records**: the controller drains the tail of
  the rotated file (same inode) before switching to the fresh one.
- **Controller: `tail` and `follow` now work on stale/closed sessions**, as the
  docs always claimed — history really does survive shutdown.
- **Controller: reattach after `/reload` no longer swallows records** (an
  `agent_settled` arriving in the reattach window was silently discarded).
- **Controller: a target that matches nothing exits 4, not 3** — a typo no
  longer tells agents to reinstall the bridge.
- **Controller: `follow` is bounded by default (30 s)**, matching its docs;
  `--for 0` streams forever. Explicit `--timeout`/`--idle-timeout` are no longer
  clobbered by `ping`/`status`/`abort` defaults.
- **Controller: outbox dedupe key includes `runId`/`kind`** — two workflow
  lifecycle records in the same millisecond no longer collapse into one.
- **rpc-run: correct exit codes** — timeout-aborted runs exit 2 (not 0), a
  failed RPC `response` exits 1 immediately (instead of hanging), and a
  non-numeric `--timeout` is a usage error.
- **Landing page**: the hero terminal now ships a static transcript (visible
  without JavaScript) and respects `prefers-reduced-motion` (no infinite
  typewriter/blink for users who asked for less motion).

### Changed
- Workflow lifecycle inference is guarded (entries must mention `workflow`) and
  documented as best-effort; false negatives degrade to exit 7 at timeout.
- Bridge inbox safety scan relaxed from 1 s to 10 s (`fs.watch` remains the
  primary trigger); outbox rotation check no longer stats the file per record.

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
