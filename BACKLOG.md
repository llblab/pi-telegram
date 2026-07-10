# Project Backlog

_This backlog tracks only open release-relevant work: live promoted-follower verification, evidence-gated Telegram client/runtime follow-ups, and upstream Pi API blockers. Completed validation evidence belongs in `CHANGELOG.md`, not in this queue._

## P0 — Private Guest DM Peer Attribution

Evidence: live private Guest Mode produced `[telegram|guest:<owner>]` for an owner-authored DM turn even though `guest` must identify the remote conversation peer. Code inspection confirms that private guest routing falls back to `fromPeer` whenever an owner-authored message has no usable `reply_to_message`; because `from.id` then equals the configured `allowedUserId`, the owner is mislabeled as the guest. Existing coverage protects incoming guest messages and owner replies with explicit replied-guest metadata, but does not cover owner-authored private guest messages without reply context.

Planned work:

- [ ] Capture or minimize the raw private `guest_message` shape for owner-authored turns without reply context and identify the stable remote-peer fields supplied by Telegram (`chat` identity, username/name/id, or another explicit peer field) before choosing a resolver.
- [ ] Centralize Guest Mode peer attribution: group turns use the group title; private non-owner turns use the sender; private owner turns use the replied guest when present and otherwise the remote private-chat peer.
- [ ] Compare ownership by Telegram user id (`allowedUserId`), not display name or username. Never emit the configured owner as `guest`; if Telegram omits a username, fall back to the remote peer's stable name/id rather than the owner.
- [ ] Keep `[reply|from:...]` and `[attachments|from:...]` source attribution aligned with the same resolved peer without changing the current-turn/source-context distinction.
- [ ] Add regressions for incoming private guests, owner replies, owner-authored no-reply turns, missing usernames, username changes, and named-profile pairing identities.
- [ ] Update the prompt-context contract/docs only after the minimized Telegram fixture establishes the actual private Guest Mode field semantics.

Done when: `[telegram|guest:...]` always identifies the remote peer or group for private/group Guest Mode, never the paired owner, and reply/attachment provenance remains source-correct.

## P0 — Guest Reply File And Audio Delivery

Evidence: live Guest Mode accepted `telegram_attach` during an active guest turn and reported the file as queued, but delivered nothing. Code inspection confirms that guest turns use sentinel `chatId: 0`; the tool appends files to `queuedAttachments`, then the agent-end guest branch sends only `answerGuestQuery` text and returns before queued attachments or voice artifacts run. Telegram's `answerGuestQuery` accepts one `InlineQueryResult`, not ordinary `sendDocument`/`sendVoice` multipart delivery, so local artifacts require a guest-specific result plan rather than reuse of chat/thread attachment transport.

Planned work:

- [x] Fail closed immediately for unsupported guest attachments until guest delivery is available; never return `Queued` when the guest agent-end path cannot consume the artifact.
- [x] Map the current Bot API `InlineQueryResult` capabilities for document, photo, audio, and voice replies, including URL versus cached `file_id`, caption limits, supported formats, and the one-result-per-guest-query constraint. `answerGuestQuery` accepts exactly one result; local multipart uploads are not accepted there. URL results require public HTTP content (documents only PDF/ZIP, audio MP3, voice OGG/OPUS, photos JPEG up to 5 MB), while cached result variants accept Telegram `document_file_id`, `photo_file_id`, `audio_file_id`, or `voice_file_id`; media captions remain limited to 0–1024 characters after entity parsing.
- [x] Design one guest reply planner that chooses exactly one result: text article, one cached local file/media with answer text reduced to a caption, or one cached synthesized voice/audio result. Guest tool admission rejects a second attachment before mutation. A failure before the one-shot answer may degrade to one text article; an ambiguous/failing `answerGuestQuery` call must not issue a second answer that could duplicate delivery.
- [x] Determine an evidence-backed local-file staging path. Local media must upload through the existing leader-owned multipart transport to the paired owner's bot chat, extract the returned Telegram `file_id`, answer the guest query with the matching cached result, and delete the staging message in `finally`. The staging message can briefly appear or notify the owner; this unavoidable Bot API limitation must be documented, no external hosting is introduced, and cleanup failure must be diagnosed rather than hidden.
- [x] Extend `answerGuestQuery` and bus forwarding from hard-coded article input to the minimal typed result union required by confirmed file/audio/voice cases.
- [x] Route `telegram_attach`, queued outbound artifacts, and `telegram_voice` through the guest planner before the guest branch returns; never call ordinary multipart methods with sentinel `chatId: 0`.
- [x] Preserve follower operation by routing staging and `answerGuestQuery` through the transport leader without duplicate answers or leaked staging messages.
- [x] Add regressions for unsupported fail-closed behavior, document/image/audio/voice result construction, caption fallback, staging cleanup/failure, multiple-file rejection, guest query one-shot semantics, and text fallback after media failure.
- [ ] Capture live private and group Guest Mode evidence for one local document and one synthesized voice/audio reply before claiming support.

Done when: guest turns never silently lose queued artifacts, one supported local file or audio/voice result can be delivered through `answerGuestQuery` with clear constraints, and unsupported/multi-file cases fail visibly without sending to an unrelated thread.

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
