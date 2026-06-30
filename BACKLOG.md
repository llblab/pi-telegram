# Project Backlog

_Current deterministic status: Threaded Mode implementation, native typing/activity status, regression coverage, docs/context reconciliation, typecheck, full tests, pack check, audit, Domain DAG validation, context validation, and core live Threaded Mode smoke are green. This backlog intentionally tracks only release-relevant remaining work: native Windows smoke, evidence-gated Telegram client follow-ups, and upstream Pi API blockers._

## P0 — Native Windows Threaded Mode Support

Context: Threaded Mode uses a local leader/follower IPC bus. Unix-like platforms use Node `net` over Unix sockets; native Windows uses Node `net` named-pipe paths. The product expectation is identical behavior across both transports: leader/follower registration, heartbeats, forwarded Telegram API calls, thread target preservation, lifecycle cleanup, and shutdown semantics should not depend on socket-vs-pipe transport.

Open work:

- [ ] Live smoke Threaded Mode on native Windows without WSL.
  - Scope: leader/follower `/telegram-connect`, follower heartbeat, forwarded Bot API calls, restore flows, lifecycle announcements, shutdown cleanup, and reconnect/reload behavior.
  - Baseline: deterministic path tests run everywhere, and a Windows-only named-pipe roundtrip regression runs when the suite executes on `win32`. Live Windows smoke remains unavailable in this environment.
- [ ] If Windows live smoke exposes pipe-specific behavior, add a minimized regression at the bus transport boundary before changing higher-level Threaded Mode logic.

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
