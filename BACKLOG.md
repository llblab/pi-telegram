# Project Backlog

_This backlog tracks only open release-relevant work: live promoted-follower verification, evidence-gated Telegram client/runtime follow-ups, and upstream Pi API blockers. Completed validation evidence belongs in `CHANGELOG.md`, not in this queue._

## P1 — Guest Media Live Follow-Ups

Context: 0.20.5 shipped deterministic Guest Mode file/audio delivery coverage. Post-release private-DM smoke confirmed that one local document reaches the remote conversation through `answerGuestQuery`; remaining checks validate Telegram client behavior rather than gate the implemented transport.

Open work:

- [x] Confirm one local document in a private Guest Mode DM after extension reload.
- [x] Confirm one synthesized paired-comment voice result in a private Guest Mode DM; Telegram delivered it to the correctly attributed remote peer without visible fallback text.
- [ ] Confirm one local document and one synthesized voice/audio result in group Guest Mode.
- [ ] Record a focused client/API caveat only if live behavior contradicts the one-result and staging contracts.

Done when: private and group Guest Mode each have direct document and voice/audio delivery evidence, or a confirmed Telegram limitation is documented.

## P1 — Compaction Status Ownership And Native Activity

Context: Pi already renders its own compaction lifecycle, while pi-telegram currently overrides its terminal status row with `compacting` whenever the shared compaction flag is set. This duplicates Pi-owned state and hides the distinction between Telegram-owned activity and unrelated automatic/session compaction. Manual `/compact` already calls the typing-loop port and automatic compaction starts typing only when an active Telegram turn exists, so the reported absence of Telegram `…typing` needs transport-level and live verification rather than an assumed rewrite.

Planned work:

- [x] Remove `compacting` as a pi-telegram terminal status label while retaining the internal compaction flag for queue/dispatch safety and explicit diagnostics.
- [x] Track compaction origin for status projection: confirmed Telegram `/compact` and auto-compaction inside a Telegram-owned turn render normal `Active`; local/autonomous/background compaction keeps the stable `connected`, `leader`, or `follower` role.
- [x] Define and verify the native activity matrix: Telegram-owned compaction targets the invoking/active thread plus `All`; non-Telegram compaction uses the connected instance target plus `All` without changing terminal role semantics.
- [x] Trace manual confirmation, `session_before_compact`, `session_compact`, completion, error, timeout, abort, and shutdown ordering to ensure one keyed typing loop remains active for the whole compaction window and always stops.
- [x] Add transport-level regressions that assert actual `sendChatAction(typing)` targets and keepalive lifecycle, not only invocation of a mocked `startTypingLoop` callback.
- [x] Replace status tests that currently require `compacting` with Telegram-owned `Active` and non-Telegram stable-role cases; preserve `/telegram-status` compaction diagnostics where operationally useful.
- [ ] Capture live evidence for manual Telegram compaction, auto-compaction during a Telegram turn, and non-Telegram auto-compaction before finalizing the activity contract.

Done when: Pi remains the only terminal owner of the `compacting` label, pi-telegram status reflects Telegram ownership rather than generic compaction, and Telegram native `…typing` remains visible and correctly targeted throughout every confirmed compaction class without leaking afterward.

## P1 — Leader Endpoint Loss Recovery

Context: live evidence showed a process retaining a fresh transport lock and active polling while its Threaded Mode Unix socket path was absent. The likely trigger was external removal of the shared Telegram temp directory while the owner process remained alive. The local server keeps listening on the unlinked Unix socket but `start()` treats its in-memory server handle as sufficient, leader health checks only Bot API transport, and a new instance therefore exhausts follower-registration retries with `ENOENT`. This is a real diagnosable recovery gap, but not yet evidence for a broad readiness protocol or automatic takeover; force-acquiring while the old owner may still run `getUpdates` would risk split-brain.

Planned work:

- [x] Reproduce deterministically by unlinking only the active Unix leader socket while its process, polling runtime, and in-memory server remain live. Native Windows named pipes have no equivalent filesystem path to unlink, so recovery remains Unix-specific unless separate named-pipe evidence appears.
- [x] Let the owning Threaded Mode runtime detect an externally missing Unix endpoint during its existing health/prune cadence and restart only the local bus server without changing lock ownership, leader epoch, polling, or thread bindings.
- [x] Make initial follower registration report `live owner / unreachable bus endpoint` after bounded retries, with direct operator guidance; do not add automatic or force takeover without separate evidence that the old owner cannot still poll.
- [x] Keep intentional classic ownership unchanged because classic mode does not require a bus endpoint.
- [x] Add focused regressions for Unix endpoint unlink/rebind, bounded follower diagnosis, leader reload overlap, and no duplicate `getUpdates` ownership; add Windows coverage only for behavior the named-pipe transport can reproduce.
- [ ] Capture live recovery evidence without deleting lock/state or creating a replacement Telegram thread.

Done when: the confirmed endpoint-loss scenario either self-recovers under the existing owner or produces precise safe remediation, while classic mode and single-owner polling remain unchanged.

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

- [ ] Capture any new Telegram client or Bot API behavior that contradicts the documented Threaded Mode contract, including a live local/autonomous `…typing` observation when convenient.
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
