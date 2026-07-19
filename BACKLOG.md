# Project Backlog

_This backlog tracks only open release-relevant work: hotfixes, bounded maintenance, live runtime verification, evidence-gated Telegram client follow-ups, and upstream Pi API blockers. Completed outcomes and validation evidence belong in `CHANGELOG.md`, not in this queue._

## P1 — Cross-Platform Runtime Persistence Optimization

Context: `owners.json`, `state.json`, and `logs.jsonl` protect different ownership, recovery, and diagnostics boundaries. Their optimized persistence paths must preserve multiple concurrent Pi instances, classic singleton ownership, Threaded Mode leader election, exact owner/generation/epoch fencing, crash recovery, and native Windows behavior. Deterministic regressions, docs, and all local release gates pass; native Windows remains the final environment-only proof.

Open work:

- [ ] Run the current diff through native Windows classic and Threaded Mode smoke: connect, ownership handoff, leader/follower registration, stale recovery, live downgrade, diagnostics rotation, and shutdown cleanup. Record named-pipe and atomic-file evidence explicitly rather than treating Linux tests as cross-platform proof.

Done when: native Windows evidence confirms that the measured filesystem-write reductions do not weaken singleton or leader/follower authority, recovery, diagnostics, or shutdown behavior.

## P1 — Evidence-Backed Telegram Client Follow-Ups

Context: The release should avoid speculative live-test matrices. Future Telegram-client quirks should be handled only when concrete evidence or a minimized fixture exists.

Open work:

- [ ] Capture any new Telegram client or Bot API behavior that contradicts the documented Threaded Mode contract, including a live local/autonomous `…typing` observation when convenient.
- [ ] Add a focused regression or documented client caveat only for confirmed behavior.
- [ ] Keep one-off environment names, thread names, and operator-specific observations out of repository context unless they demonstrate a general product issue.

Done when: new client quirks are either fixed with targeted coverage or documented as evidence-backed exceptions, without keeping broad manual smoke matrices in the backlog.

## Blocked — Same-Thread Telegram `/new`

Blocked: upstream Pi core API. Issue: https://github.com/earendil-works/pi/issues/5952

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
