# Project Backlog

_This backlog tracks only open release-relevant work: hotfixes, bounded maintenance, live runtime verification, evidence-gated Telegram client follow-ups, and upstream Pi API blockers. Completed outcomes and validation evidence belong in `CHANGELOG.md`, not in this queue._

## P0 — 0.26.11 Windows Release Gates

Context: the first final release matrix correctly held publication after loaded Windows scheduling exceeded two integration-only deadlines: queued model-menu completion and graceful shutdown of a full-Pi parent fixture. Neither failure changed the runtime feature contract, but both gates must remain bounded and preserve their exact assertions.

Open work:

- [x] Recheck the generic integration predicate at its deadline and give only the model-menu completion assertion a five-second budget.
- [x] Give the full-Pi parent fixture up to ten seconds to complete graceful shutdown after its stop marker, without weakening exit-code or child-poll assertions.
- [ ] Pass two fresh Linux/macOS/Windows matrices after these final changes.

Done when: both Windows-sensitive evidence paths complete under runner load, genuine hangs remain bounded and diagnostic, and two consecutive release matrices pass before merge.

## P0 — Settings Description Choice Ordering

Context: Settings detail copy historically tended to place the default value first. The default is metadata, not an ordering rule. Value descriptions should mirror the actual choice controls so operators can scan explanatory text and buttons in the same sequence.

Open work:

- [x] Order every core Settings value-description list exactly like its selectable controls: keyboard rows top-to-bottom and values within a shared row left-to-right; never move a value merely because it carries `(default)`.
- [x] Keep `(default)` attached to the actual default wherever that value falls in control order; for example, Draft previews should describe `on` before `off (default)` because the buttons display On then Off, while Activity should retain `quiet`, `thinking`, `tools`, `verbose (default)`.
- [x] Make the option/control order the explicit source of truth or protect parity with focused regressions so description and keyboard order cannot drift independently.
- [x] Live-smoke the Settings detail ordering before the guarded release flow.

Done when: every Settings description follows its visible chooser rather than default-first history, default annotations remain truthful, automated parity coverage passes, and live Telegram screens confirm scan order.

## P0 — Nested Tool Evidence List Styling

Context: nested Rich tool evidence labels should read like quote-free outer JSON keys rather than peer headings or list items. Plain lowercase labels distinguish evidence children from the root without adding a redundant marker. Root labels remain sentence-case, but tool names beginning with a two- or three-character run of the same ASCII letter should preserve that recognizable prefix as uppercase instead of flattening it to one initial capital.

Open work:

- [x] Render each child summary as a marker-free plain lowercase label: `arguments`, `update N (K earlier omitted)`, `result`, or `error`.
- [x] At the root level only, uppercase a leading repeated-letter run when its length is two or three, then retain ordinary label casing for the remainder; examples: `ffgrep` → `FFgrep`, `fffind` → `FFFind`, and `bash` → `Bash`.
- [x] Keep Arguments open-by-default behavior intact, secondary nodes collapsed, and all JSON evidence, bounds, ordering, coalescing, redaction, fallback, and fencing guarantees unchanged.
- [x] Update focused Rich block regressions, durable UI documentation, changelog, and package metadata.
- [x] Live-smoke `FFFind` and `Bash` roots plus the nested hierarchy, then remove the redundant minus from the final design in response to operator feedback.

Done when: opening a tool root reveals compact quote-free evidence keys without adding height, all evidence behavior remains intact, automated validation passes, live clients confirm the hierarchy, and the hotfix clears the guarded release flow.

## P1 — Windows Graceful Disconnect Test Budget

Context: the graceful follower-disconnect integration overrides the production 30-second bus budget with 500 milliseconds even though the path persists cleanup intent, performs close/delete operations, updates binding state, and returns an authenticated response. A loaded Windows runner exceeded that artificial deadline while the same focused path completes promptly under normal scheduling.

Open work:

- [x] Give this integration-only bus round trip a realistic bounded timeout without changing production transport defaults, retries, cleanup ordering, or assertions.
- [x] Validate repeatedly and across hosted platforms before publishing `0.26.10`.

Done when: slow Windows scheduling can complete the real graceful cleanup path, genuine hangs remain bounded, exact cleanup evidence stays asserted, and Linux/macOS/Windows CI passes.

## P1 — Windows Filesystem And Timer Resilience Release

Context: hosted Windows exposed two independent assumptions: atomic config replacement can transiently fail with `EPERM` while another system component holds the destination, and a five-millisecond ownership-refresh interval may not receive CPU within a 250-millisecond test deadline under runner load.

Open work:

- [x] Retry only transient Windows config-replacement errors within the existing file transaction, preserving atomic temp-file rename and bounded failure.
- [x] Recheck the ownership predicate at the polling boundary and give that interval regression a realistic bounded scheduling budget without changing runtime cadence or assertions.
- [x] Validate focused regressions and the full suite across hosted platforms; publish and verify `0.26.9`.

Done when: concurrent config transactions survive transient destination contention, slow timer scheduling still reaches the ownership assertion, genuine failures remain bounded and diagnostic, and Linux/macOS/Windows CI passes.

## P1 — Windows Process-Startup Timing Release

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
