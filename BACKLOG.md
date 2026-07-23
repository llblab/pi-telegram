# Project Backlog

_This backlog tracks only open release-relevant work: hotfixes, bounded maintenance, live runtime verification, evidence-gated Telegram client follow-ups, and upstream Pi API blockers. Completed outcomes and validation evidence belong in `CHANGELOG.md`, not in this queue._

## P0 — `0.24.4` Disconnect Model-Context Availability Hotfix

Context: Issue #146 proves that a successfully disconnected instance still exposes `telegram_attach`, `telegram_message`, and `telegram_help`, their active-tool prompt metadata, and a system-prompt claim that Telegram remains available. Execute-time transport guards reject later local/TUI delivery, so the model receives stale capabilities and spends context on an unavailable bridge.

Open work:

- [ ] Reconcile pi-telegram's model-context tools and local system-prompt suffix against effective direct-owner or registered-follower authority, preserve the operator's prior pi-telegram active-tool subset and every non-pi-telegram tool, and restore only that subset after authority recovery.
- [ ] Give temporary command threads the same forward and replace/restore controls as other unbound threads. Successful forward must delete the chooser and temporary thread; successful restore must delete the chooser, rebind the temporary thread, and delete only the replaced old thread.
- [ ] Treat graceful Pi instance quit as an unconfirmed automatic `/telegram-disconnect` by default: delete the current Threaded Mode tab and release authority without prompting, expose a compact Settings/config toggle to preserve restart hints, and retain manual command confirmation plus same-process `reload`, `new`, `resume`, and `fork` handoff semantics.

Done when: deterministic regressions cover initial disconnected state, successful and failed disconnect, connect/recovery, direct ownership and follower registration loss, session reload, user-disabled Telegram tools, next-request prompt metadata, preservation of foreign tools, unchanged execute-time fencing, complete temporary-command-thread controls, distinct forward-delete versus restore-rebind cleanup, graceful quit teardown, and non-quit session replacement preservation.

## P0 — Expiring Pi Shrinkwrap Audit Exception

Deadline: 2026-08-21 UTC. The validation gate intentionally fails at `2026-08-22T00:00:00Z` if either exception remains.

Context: `@earendil-works/pi-coding-agent@0.80.6` publishes its own `npm-shrinkwrap.json`, which prevents this consumer package from replacing two installed vulnerable copies. The repository temporarily permits only `brace-expansion@5.0.6` / source `1123898` / `GHSA-3jxr-9vmj-r5cp` and `protobufjs@7.6.4` / source `1123964` / `GHSA-j3f2-48v5-ccww`, plus parent findings whose complete audit graph resolves exclusively to those sources. `npm run audit` verifies the exact graph, installed paths and versions, and expiry; every unknown or changed finding fails closed.

Open work:

- [ ] Upgrade to a Pi release whose published shrinkwrap installs `brace-expansion>=5.0.7` and `protobufjs>=7.6.5`, remove the exception policy, and restore a zero-finding raw `npm audit` before the deadline.

Done when: a clean `npm ci` followed by raw `npm audit` reports zero vulnerabilities and the expiring policy/overrides are removed.

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
