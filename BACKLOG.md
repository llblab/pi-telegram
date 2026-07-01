# Project Backlog

_Current deterministic status: Threaded Mode implementation, native typing/activity status, regression coverage, docs/context reconciliation, typecheck, full tests, pack check, audit, Domain DAG validation, context validation, and core live Threaded Mode smoke are green. This backlog intentionally tracks only release-relevant remaining work: native Windows smoke, evidence-gated Telegram client follow-ups, and upstream Pi API blockers._

## P0 — Live Threaded Mode Regression Sweep

Context: live Linux testing exposed regressions around prompt dispatch readiness, visible thread rename noise during automatic leader reclaim, status thread-name fallback flicker, and follower voice/update forwarding health. These are local runtime correctness issues and must be validated before returning to Windows smoke.

Open work:

- [x] Hide minimal model-menu one-page pagination and keep scope tabs progressive.
- [x] Add immediate-plus-deferred inbound prompt dispatch so queued prompts do not wait for a later `/reload` or command.
- [x] Stop automatic leader reclaim/reconciliation paths from visibly calling `editForumTopic` for internal identity restoration.
- [x] Prevent leader auto-claim of an unknown unbound thread while another live thread target exists, covering same-directory leader/follower smear risk.
- [x] Prefer local live leader/follower target labels over stale shared thread-store records when building prompt prefixes.
- [x] Permit follower-safe bot identity reads and own-chat native activity through the leader API proxy without granting cross-thread message/file/topic writes.
- [x] Preserve leader thread-name fallback in live status state to reduce `Dune`/generic `Telegram` flicker.
- [ ] Live smoke on Linux with one leader and one follower:
  - [x] clean-state pass after removing `tmp/telegram` so stale diagnostic snapshots do not obscure live behavior;
  - [ ] dirty-state pass with old `state.json`/`logs.jsonl` present to prove live locks, bus registration, target ownership, and reconciliation override stale diagnostics;
  - [x] follower thread receives raw voice/message updates through the leader bus;
  - [x] follower-local handlers from that instance's `telegram.json` process voice independently;
  - [x] same-directory leader/follower sessions keep distinct thread bindings;
  - [ ] leader reload recovers without duplicate visible thread renames;
  - [ ] prompts dispatch without a second command;
  - [ ] status remains stable around thread name and role while active turns start/end.
- [ ] Add/keep proactive race protections so `state.json` never becomes authoritative over live lock ownership, bus registration, or current target identity.

Done when: local Linux live Threaded Mode smoke is stable for leader reload, follower connect, prompt dispatch, voice forwarding, and status naming without visible rename noise.

## P0 — Native Windows Threaded Mode Support

Context: Threaded Mode uses a local leader/follower IPC bus. Unix-like platforms use Node `net` over Unix sockets; native Windows uses Node `net` named-pipe paths. The product expectation is identical behavior across both transports: leader/follower registration, heartbeats, forwarded Telegram API calls, thread target preservation, lifecycle cleanup, and shutdown semantics should not depend on socket-vs-pipe transport. This remains after the local Linux regression sweep is green.

Open work:

- [ ] Deep Windows Threaded Mode research pass before further release:
  - prioritize the Bus Transport boundary first: common bus protocol vs Unix socket transport vs Windows named-pipe transport;
  - map leader/follower lifecycle from `/telegram-connect` through lock acquire, named-pipe server start, follower receiver start, registration, heartbeat, registry pruning, forwarding, and dispatch;
  - isolate PowerShell-vs-CMD differences around `PI_CODING_AGENT_DIR`, cwd normalization, process liveness, inherited environment, and named-pipe path derivation;
  - add diagnostic probes that expose lock path, pipe path, leader epoch, follower receiver path, registry entries, heartbeat age, and dispatch blocked reason without relying on `state.json` as authority;
  - verify Telegram-originated assistant replies remain visible in the ordinary terminal/TUI transcript; Telegram delivery must be an external control/delivery membrane, not a replacement path that changes local terminal behavior;
  - produce minimized Windows-relevant regressions before changing higher-level routing again.
- [ ] Live smoke Threaded Mode on native Windows without WSL.
  - Scope: leader/follower `/telegram-connect`, follower heartbeat, forwarded Bot API calls, restore flows, lifecycle announcements, shutdown cleanup, and reconnect/reload behavior.
  - Observed: a same-directory follower can see a live leader lock but fail registration with `connect ENOENT \\.\\pipe\\...`, leaving the follower disconnected during leader reload/hot activation timing.
  - Observed: Windows/QEMU live polling/dispatch can lag until reload; inbound messages appear to increase the extension queue count, but the next queued item is not dispatched promptly.
  - Observed: after a follower shows `Instance ... connected`, messages in its thread can still fall back to `not connected to the Telegram bus yet`, consistent with leader-side heartbeat pruning or registry loss while the follower receiver may still be alive.
  - Baseline: deterministic path tests run everywhere, and a Windows-only named-pipe roundtrip regression runs when the suite executes on `win32`. Live Windows smoke remains unavailable in this environment.
Done when: Threaded Mode leader/follower operation works on native Windows with the same safety guarantees as Unix-like systems, and unsupported transport assumptions are covered by tests/docs.

## P1 — Evidence-Backed Telegram Client Follow-Ups

Context: The release should avoid speculative live-test matrices. Deterministic coverage already protects target propagation, native typing/activity scoping, hot Threaded Mode upgrade/downgrade, delivery routing, and core leader/follower behavior. Future Telegram-client quirks should be handled only when there is concrete evidence or a minimized fixture.

Open work:

- [ ] Capture any new Telegram client or Bot API behavior that contradicts the documented Threaded Mode contract.
- [ ] Add a focused regression or documented client caveat only for confirmed behavior.
- [ ] Keep one-off live environment names, thread names, and operator-specific observations out of repository context unless they demonstrate a general product issue.

Done when: new client quirks are either fixed with targeted coverage or documented as evidence-backed exceptions, without keeping broad manual smoke matrices in the backlog.

## P1 — Evidence-Backed Rich Markdown Normalization

Context: Native Rich Markdown is the default assistant delivery path. Existing regressions cover known parser/client edges such as space-after-marker blockquotes, dollar-prefixed ticker atoms, list indentation, code fences, links, display math normalization, and long-message splitting. Further rewrites should be evidence-driven, not speculative.

Open work:

- [ ] Capture any new Telegram parser-breaking sequence from live/client evidence or a minimized fixture.
- [ ] Add a conservative normalization or safe-degradation rule only for confirmed sequences.
- [ ] Keep unconfirmed speculative rewrites out of the delivery path.

Done when: newly observed Rich Markdown failures have minimized fixtures and targeted regressions, while stable rendering behavior remains unchanged for unsupported guesses.

## Blocked — Same-Thread Telegram `/new`

Blocked: upstream Pi core API. Issue: https://github.com/earendil-works/pi/issues/5952

Context: Threaded Mode manual followers are separate visible Pi processes. Same-thread `/new` is a different feature: replacing the current Pi session inside the same Telegram thread. Extension-only hacks are rejected because they would desynchronize Pi lifecycle/TUI semantics.

Required upstream shape:

- `pi.newSession(...)` or `pi.requestSessionReplacement(...)` callable from trusted extension runtime code.
- Must use the same session-replacement path as the terminal command, including normal `session_shutdown` / `session_start` lifecycle.

Constraints:

- Do not store stale `ExtensionCommandContext`.
- Do not inject TUI input.
- Do not spawn a shadow `pi` subprocess.
- Do not mutate session files directly.
- Do not route through `pi.exec`; it is shell execution, not a Pi slash-command dispatcher.

Done when: `/new` in the current Telegram thread performs an official same-instance session replacement, preserves the thread binding, rebinds after lifecycle restart, reports success/cancellation in the same thread, and has regressions for active turns, pending Pi messages, queue state, preview cleanup, cancellation, failure, and success.
