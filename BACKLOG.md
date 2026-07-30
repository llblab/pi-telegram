# Project Backlog

_This backlog tracks only open release-relevant work: hotfixes, bounded maintenance, live runtime verification, evidence-gated Telegram client follow-ups, and upstream Pi API blockers. Completed outcomes and validation evidence belong in `CHANGELOG.md`, not in this queue._

## P0 — Windows Process-Startup Timing Hotfix

Context: the process-lock regression can start a full Pi child more slowly than the three-second marker deadline on hosted Windows. Unlike the previous boundary case, the empty final marker proves the parent had not completed extension startup yet; runtime lock behavior was never reached.

Open work:

- [x] Give the cold-start readiness marker and parent watchdog a Windows-safe bounded budget without weakening the no-child-poll assertion.
- [x] Validate the focused process test and full suite across hosted platforms; publish and verify `0.26.8`.

Done when: slow Windows startup reaches the same lock assertion deterministically, genuine hangs remain bounded and diagnostic, and CI passes on Linux, macOS, and Windows.

## P1 — macOS Follower Reload Identity Release

Context: macOS lacks Linux `/proc` start ticks, so a follower previously received a generation-based profile identity on each extension reload. Initial registration could also race ahead of session refresh before the old target was restored, causing a duplicate Telegram thread.

Open work:

- [x] Derive stable Darwin process-birth identity from `/bin/ps` while preserving Linux start ticks and generation fallback.
- [x] Carry a fresh previous runtime identity and exact target through initial follower registration, migrate the old binding after a visibility probe, and consume the handoff only after acknowledgement.
- [x] Replace the helper-only regression with a runtime-level registration test covering failed-attempt retention, envelope evidence, acknowledgement, and handoff consumption.
- [x] Update durable context, multi-instance documentation, changelog, and package metadata.
- [x] Validate on Linux, macOS, and Windows; publish and verify `0.26.7`.

Done when: same-process follower reload preserves one thread and binding, the race is covered at the runtime boundary, all hosted platforms pass, and the hotfix is published.

## P1 — Windows Poll-Wait Boundary Release

Context: a Windows process-lock regression reached its expected `parent:getUpdates` marker at the polling deadline, but the shared wait helper failed immediately after its final read without applying the predicate to that last value. This produces a false timeout despite successful behavior.

Open work:

- [x] Reapply the predicate after the final file read before reporting a timeout.
- [x] Validate the process-lock regression across hosted platforms and publish `0.26.6`.

Done when: deadline-edge marker arrival succeeds, genuine missing markers still fail with evidence, and CI passes on Linux, macOS, and Windows.

## P1 — Scoped Model Thinking Label Release

Context: scoped model buttons still separate their optional thinking level with a middle dot. Parentheses match the quieter subordinate-metadata convention now used by Activity update omission labels.

Open work:

- [x] Render scoped model buttons as `provider/model (level)` when a thinking level is attached.
- [x] Update focused regression, changelog, and package metadata.
- [x] Publish and verify GitHub/npm release evidence for `0.26.5`.

Done when: optional thinking metadata uses parentheses consistently, validation passes, and the hotfix is published.

## P1 — Update Omission Label Release

Context: the retained-update summary currently separates its dropped-count suffix with a middle dot. Parentheses communicate subordinate metadata more quietly and avoid an unnecessary visual separator.

Open work:

- [x] Render the first retained update as `Update N (K earlier omitted)` when earlier updates were dropped.
- [x] Update focused regression, changelog, and package metadata.
- [x] Publish and verify GitHub/npm release evidence for `0.26.4`.

Done when: omission metadata uses ordinary parentheses, validation passes, and the hotfix is published.

## P1 — Open Arguments Live Smoke

Context: opening a tool root currently reveals another closed Arguments disclosure, forcing a second tap before the most useful invocation evidence becomes visible. Telegram Rich details support `is_open`, so only the first Arguments child can open with its parent while updates and results remain collapsed.

Open work:

- [x] Mark each Arguments child details node open by default without opening the tool root or later evidence nodes.
- [x] Update focused regressions, documentation, durable UI rules, changelog, and package metadata.
- [x] Publish and verify GitHub/npm release evidence for `0.26.3`.
- [ ] Live-smoke the one-tap tool inspection path on Telegram mobile/Desktop.

Done when: one tap on a collapsed tool root reveals its arguments immediately, secondary evidence remains compact, automated validation passes, live clients confirm the disclosure state, and the hotfix is published.

## P1 — Iconless Tool Root Live Smoke

Context: native Rich details already supply a chevron, bold tool name, and monospaced status. Repeating `🛠` on every coalesced root adds visual noise and no longer matches the headerless thinking surface.

Open work:

- [x] Remove the tool emoji from Rich root summaries while retaining `<Tool>: <status>`, nesting, fallback safety, and all delivery guarantees.
- [x] Update regressions, documentation, durable UI rules, changelog, and package metadata.
- [x] Publish and verify GitHub/npm release evidence for `0.26.2`.
- [ ] Live-smoke multiple consecutive iconless tool roots on Telegram mobile/Desktop.

Done when: the native chevron alone identifies each collapsed tool root, automated validation passes, live clients confirm scanability, and the hotfix is published.

## P1 — Compact Activity Tree Live Smoke

Context: `0.26.0` proved the Rich tool-details direction but retained one standalone line for every thinking header and every tool header. The compact default removes the thinking header entirely and makes each tool call itself the closed root details node containing nested Arguments/Update/Result/Error details.

Open work:

- [x] Render thinking as only its existing HTML expandable quote, without a separate `Thinking: <level>` line.
- [x] Render each Rich tool as one closed root details summary `<Tool>: <status>` whose children are the existing closed JSON evidence details; preserve multi-tool coalescing, fallback, bounds, redaction, ordering, and fencing.
- [x] Update regressions, README/docs, durable UI rules, changelog, and package metadata.
- [x] Publish and verify GitHub/npm release evidence for `0.26.1`.
- [ ] Live-smoke compact thinking and nested tool trees on Telegram mobile/Desktop in classic and Threaded Mode.

Done when: thinking costs no standalone header row, each collapsed tool costs one root row, expanding a tool reveals only logical evidence nodes, automated validation passes, live clients confirm nested disclosure behavior, and the hotfix is published.

## P1 — Configurable Activity Live Smoke

Context: `0.26.0` shipped configurable quiet, thinking-only, tools-only, and verbose modes with absent-config `verbose` plus interval time-injection defaults. Thinking uses persistent collapsed ordinary HTML; completed tools use native Rich details with separate JSON code blocks.

Open work:

- [ ] Live-smoke all four modes in classic and Threaded Mode on Telegram mobile and Desktop, including progressive headerless thinking edits, collapsed tool roots with nested Arguments/Update/Result/Error details, multiple sequential tools, oversized output rollover, cancellation during thinking, tool failure and known-safe HTML fallback, session replacement, follower transport, and final-answer ordering.
- [ ] From omitted settings, verify `verbose` Activity and one-hour interval time injection activate without persistence or migration; then verify explicit quiet/hidden and single-class settings remain authoritative across live instances.

Done when: live mobile and Desktop clients confirm mode/default isolation, persistent thinking, structured Rich tool disclosures, routing, rollover, cancellation, failure/fallback, explicit overrides, and final-answer ordering in classic and Threaded Mode.

## P1 — Native Windows Runtime Smoke

Context: Deterministic ownership, persistence, recovery, process, and named-pipe coverage passes on native hosted Windows. A live Telegram client remains the only unverified platform boundary and may be exercised in a later release cycle rather than tied to a specific version.

Latest automated evidence: the `0.24.11` base commit `313b4ee` passed the complete `windows-latest` typecheck, test, and package job on 2026-07-25 ([Actions run 30174521046](https://github.com/llblab/pi-telegram/actions/runs/30174521046)). This proves native hosted-Windows automation, not the operator-driven Telegram/named-pipe smoke below.

Open work:

- [ ] Run a current build through native Windows classic and Threaded Mode smoke: connect, ownership handoff, leader/follower registration, stale recovery, live downgrade, diagnostics rotation, and shutdown cleanup. Record concrete named-pipe, atomic-file, and Telegram-client evidence.

Done when: native Windows live evidence confirms singleton and leader/follower authority, recovery, diagnostics, downgrade, and shutdown behavior.

## Blocked — Same-Thread Telegram `/new`

Blocked: upstream Pi core API remains unavailable. Issue #5952 was auto-closed by intake policy rather than resolved: https://github.com/earendil-works/pi/issues/5952

Context: Threaded Mode manual followers are separate visible Pi processes. Same-thread `/new` is a different feature: replacing the current Pi session inside the same Telegram thread. Extension-only hacks are rejected because they would desynchronize Pi lifecycle/TUI semantics.

Current upstream evidence (reverified 2026-07-28): issue #5952 remains closed as `not planned` by the new-contributor intake automation. The maintainer described an async extension bridge as potentially possible after the current refactor, subsequent users added supporting use cases through 2026-07-12, and no supported API or implementation was posted. The latest published Pi is 0.82.1; its current `main` `ExtensionAPI` still has no `newSession` or session-replacement method, while `ctx.newSession()` remains limited to registered extension commands through `ExtensionCommandContext`, including fresh-context rebinding after replacement. Telegram update and callback handlers receive only `ExtensionContext`, and extension-origin `pi.sendUserMessage()` deliberately disables slash-command handling.

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
