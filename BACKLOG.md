# Project Backlog

_This backlog tracks only open release-relevant work: hotfixes, bounded maintenance, live runtime verification, evidence-gated Telegram client follow-ups, and upstream Pi API blockers. Completed outcomes and validation evidence belong in `CHANGELOG.md`, not in this queue._

## P1 — Native Windows Runtime Smoke

Context: Deterministic ownership, persistence, recovery, process, and named-pipe coverage passes on native hosted Windows. A live Telegram client remains the only unverified platform boundary and may be exercised in a later release cycle rather than tied to a specific version.

Open work:

- [ ] Run a current build through native Windows classic and Threaded Mode smoke: connect, ownership handoff, leader/follower registration, stale recovery, live downgrade, diagnostics rotation, and shutdown cleanup. Record concrete named-pipe, atomic-file, and Telegram-client evidence.

Done when: native Windows live evidence confirms singleton and leader/follower authority, recovery, diagnostics, downgrade, and shutdown behavior.

## Blocked — Same-Thread Telegram `/new`

Blocked: upstream Pi core API remains unavailable. Issue #5952 was auto-closed by intake policy rather than resolved: https://github.com/earendil-works/pi/issues/5952

Context: Threaded Mode manual followers are separate visible Pi processes. Same-thread `/new` is a different feature: replacing the current Pi session inside the same Telegram thread. Extension-only hacks are rejected because they would desynchronize Pi lifecycle/TUI semantics.

Current upstream evidence: Pi 0.80.6 safely exposes `ctx.newSession()` to registered extension commands through `ExtensionCommandContext`, including fresh-context rebinding after replacement. Telegram update and callback handlers still receive only `ExtensionContext`, and extension-origin `pi.sendUserMessage()` deliberately disables slash-command handling. The upstream maintainer described an async extension bridge as potentially possible after the current refactor, but no supported API exists yet.

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
