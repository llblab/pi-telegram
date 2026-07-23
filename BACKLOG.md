# Project Backlog

_This backlog tracks only open release-relevant work: hotfixes, bounded maintenance, live runtime verification, evidence-gated Telegram client follow-ups, and upstream Pi API blockers. Completed outcomes and validation evidence belong in `CHANGELOG.md`, not in this queue._

## P0 — `0.24.5` Unclean-Shutdown Runtime Recovery Hotfix

Context: A sudden computer power loss can leave pi-telegram's disposable `tmp/telegram` authority or routing artifacts truncated or structurally unverifiable. Current `/telegram-connect` behavior exposes raw JSON errors or transaction timeouts and remains blocked until the operator manually deletes `tmp/`. Deterministic probes reproduce three distinct failures: truncated `owners.json`, truncated `state.json`, and an unverifiable `owners.json.transaction` guard. A non-mutating recovery classifier now distinguishes recoverable corruption from corruption protected by a verifiable live owner or transaction holder. A serialized recovery primitive revalidates under the ownership transaction, quarantines only classifier-approved temporary artifacts, and preserves configuration and diagnostics. `/telegram-connect` now classifies failed startup, stops local polling before recovery, retries exactly once after a successful reset, preserves unrelated errors, and converts blocked or failed recovery into one explicit restart instruction. Stale eight-second owner heartbeats do not block recovery merely because the operating system reused a PID. Cross-process regressions now prove one-writer recovery for combined malformed owners/state/guard debris, and failed quarantine creation leaves corruption retryable. The composition handler has a dedicated domain seam, and an end-to-end command regression proves actual filesystem reset, preserved config, one reconnect attempt, and a clean subsequent connect. A bounded composition-root audit moved follower active-auth and transient-election state into its owning domain while retaining direct runtime wiring and the intentional late-bound availability port in `index.ts`. Runtime liveness takes priority over preserving disposable session/thread observations, while durable `telegram.json` configuration and proof of a live competing owner remain protected.

Open work:

- [ ] Complete the Ubuntu/macOS/Windows CI and guarded `dev → main` patch release flow.

Done when: after recoverable power-loss debris, one `/telegram-connect` either reconnects from a clean temporary runtime state or reports one explicit restart instruction; it never loops, deletes durable config, races a proven live owner, or requires broad manual `tmp/` deletion. Hosted Ubuntu/macOS/Windows validation and release verification pass.

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
