# Project Backlog

_This backlog tracks only open release-relevant work: hotfixes, bounded maintenance, live runtime verification, evidence-gated Telegram client follow-ups, and upstream Pi API blockers. Completed outcomes and validation evidence belong in `CHANGELOG.md`, not in this queue._

## P1 — Cross-Platform Runtime Persistence Optimization

Context: `owners.json`, `state.json`, and `logs.jsonl` protect different ownership, recovery, and diagnostics boundaries. Their optimized persistence paths must preserve multiple concurrent Pi instances, classic singleton ownership, Threaded Mode leader election, exact owner/generation/epoch fencing, crash recovery, and native Windows behavior. Deterministic regressions, docs, and all local release gates pass; native Windows remains the final environment-only proof.

Open work:

- [ ] Run the current diff through native Windows classic and Threaded Mode smoke: connect, ownership handoff, leader/follower registration, stale recovery, live downgrade, diagnostics rotation, and shutdown cleanup. Record named-pipe and atomic-file evidence explicitly rather than treating Linux tests as cross-platform proof.

Done when: native Windows evidence confirms that the measured filesystem-write reductions do not weaken singleton or leader/follower authority, recovery, diagnostics, or shutdown behavior.

## P1 — Cross-Platform CI Matrix

Context: Validation now targets `ubuntu-latest`, `macos-latest`, and `windows-latest` at minimum Node `22.19.0`. Typecheck, tests, and package dry-run run on every OS; audit runs once on Ubuntu; release publication remains separate. The workflow parses and all local gates pass, but the first hosted matrix run requires a push or pull request.

Open work:

- [ ] Verify that the first hosted matrix passes and that the Windows named-pipe roundtrip executes rather than skips, while Unix socket and atomic-publication tests remain active on Ubuntu and macOS. Document any intentional platform skip by protected boundary.

Done when: hosted CI exercises the minimum supported Node across Linux, macOS, and native Windows; deterministic validation and package shape pass on each OS; and all skips remain intentional and visible.

## P1 — Native Windows Threaded Mode Follow-Ups

Context: Native Windows smoke on the WIP `dev` build passes for classic mode, ownership handoff, hot upgrade to Threaded Mode, leader/follower registration and delivery, and hot downgrade back to classic with follower disconnect. Observed downgrade status convergence can take around 10 seconds, which fits the current 5–15 second retry window but should remain evidence-gated if it becomes user-visible friction.

Open work:

- [ ] Capture text diagnostics if Windows classic restore/status convergence repeatedly exceeds the intended fallback window.
- [ ] Add a focused regression or transport/status adjustment only if new Windows evidence shows a repeatable named-pipe, lock, heartbeat, queue, or status-convergence issue.
- [ ] For every Windows connect/runtime crash report, classify the failing boundary (`owners.json` atomic write, named pipe, heartbeat, polling, queue, or status), ensure `logs.jsonl` captures enough redacted evidence before shutdown, and add a minimized regression when the failure can be simulated deterministically.

Done when: new Windows-specific runtime issues are either fixed with targeted coverage or left out of the backlog because native smoke remains green.

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
