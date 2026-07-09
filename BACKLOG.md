# Project Backlog

_This backlog tracks only open release-relevant work: live promoted-follower verification, evidence-gated Telegram client/runtime follow-ups, and upstream Pi API blockers. Completed validation evidence belongs in `CHANGELOG.md`, not in this queue._

## P1 — Promoted Follower Reload Evidence

Context: deterministic coverage protects promoted follower thread preservation, and the latest live Linux smoke closed reload routing, follower Active, and reroute/restore regressions. The exact promoted-leader reload path is deliberately outside the 0.20.1 profile IPC hotfix because it is unrelated to profile transport isolation; keep it as an evidence-gated follow-up rather than blocking that release.

Open work:

- [ ] Capture live evidence that leader → follower promotes → `/reload` preserves the promoted leader's Telegram thread identity.

Done when: promoted-follower reload identity has direct live Telegram evidence.

## P1 — Native Windows Threaded Mode Follow-Ups

Context: Native Windows smoke on the WIP `dev` build now passes for classic mode, classic ownership handoff, hot upgrade to Threaded Mode, leader/follower registration and delivery, and hot downgrade back to classic with follower disconnect. The observed downgrade status convergence can take around 10 seconds, which is acceptable for the current retry-based safety model but should remain evidence-gated if it becomes user-visible friction.

Open work:

- [ ] Capture text diagnostics if Windows classic restore/status convergence repeatedly exceeds the intended 5–15 second fallback window.
- [ ] Add a focused regression or transport/status adjustment only if new Windows evidence shows a repeatable named-pipe, lock, heartbeat, queue, or status-convergence issue.
- [ ] For every Windows connect/runtime crash report, classify the failing boundary (`locks.json` atomic write, named pipe, heartbeat, polling, queue, or status), ensure `logs.jsonl` captures enough redacted evidence before shutdown, and add a minimized regression when the failure can be simulated deterministically.

Done when: new Windows-specific runtime issues are either fixed with targeted coverage or left out of the backlog because the native smoke remains green.

## P1 — Evidence-Backed Telegram Client Follow-Ups

Context: The release should avoid speculative live-test matrices. Future Telegram-client quirks should be handled only when there is concrete evidence or a minimized fixture.

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
