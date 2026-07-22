# P0/P1 Reliability, Safety, Merge, and GitHub Release Execution Contract

Status: plan quality gate clean after 3/3 review rounds and parent final audit
Baseline date: 2026-07-22
Implementation base: `origin/dev` at `a674c55` (`0.24.2`)
Release baseline: `origin/main` at `1a1d4a6`, tag `v0.24.2`
Execution scope: prerequisite semantic port excluding Telegram `/new`, all residual P0, all residual P1, merge promotion, tag, and GitHub Release

## 0. Plan quality contract

- During the planning loop, only this file may be edited. Implementation begins only after the plan review gate accepts this contract.
- The implementation worker must treat the commit ids, state transitions, permissions, retention, identity predicates, fault ids, commands, and branch targets below as requirements, not suggestions.
- There are no unresolved product decisions. Conservative defaults in this document are approved.
- A source fact that invalidates a requirement is a stop condition: record the conflicting file/commit and obtain plan review rather than inventing a replacement design.
- Baseline red tests are demonstrated only in a disposable probe at `a674c55`; no committed PR head may intentionally remain red.
- Every implementation PR must preserve the Flat Domain DAG, keep `index.ts` composition-only, use mirrored domain tests, update user/runtime documentation in the same PR, and pass the gates assigned below.
- The executor may push branches, open and merge PRs, push the version tag, and create/verify the GitHub Release because those external writes were explicitly authorized. Before the first external write, it must verify actual `git`/`gh` credentials and repository permissions. Missing permission is a runtime access blocker, not a plan-design question.
- Any live Telegram write remains separately gated: immediately before the smoke, obtain approval for the exact profile/target and exact benign message/file content. No approval is needed to implement or validate with local fixtures.
- GitHub Release is in scope. **npm publication is out of scope**: the repository has no npm publish workflow and this task grants no registry authority. Do not run `npm publish`, create registry credentials, or describe the GitHub Release as an npm publication.
- Completion requires the disposition inventory in §4 to remain exhaustive, all slice evidence to exist, all review findings to be closed or evidence-backed rejected, and the completion audit in §12 to pass.

## 1. Goal and bounded guarantees

Deliver the fork's intended custom operator behavior on current upstream, then close the remaining reliability and security defects in two ordered programs: all P0 work first, then all P1 work, then a `dev -> main` release promotion and GitHub Release.

The release guarantees:

1. Every Telegram API attempt has a bounded deadline, and polling cannot remain dead while transport ownership heartbeat remains live.
2. Offset/admission processing is **at-least-once with stable idempotency**. Pre-dispatch work is automatically replayable. A crash after Pi dispatch may have begun becomes `execution-uncertain` and is never automatically replayed.
3. Completed answers have a durable outbox. Known-not-committed failures can retry; commit-ambiguous Telegram, bus, Pi, or other non-idempotent effects become an operator-visible `*-uncertain` state.
4. Fencing prevents stale local work from starting and prevents stale state commits. It does not claim that a remote call already racing an ownership change can be cancelled; that call is classified as uncertain when its commit cannot be proven.
5. An unpaired bot accepts only an exact, private-human `/start <code>` claim before normal routing. Existing `allowedUserId` installations continue unchanged.
6. Recovery payloads are private at rest and bounded by quota. Logs and status expose metadata only.
7. Same-process session replacement can reclaim authenticated handoff work. Same-CWD alone never identifies a follower. After a full process/parent restart, upstream cannot prove continuity of the old manual-follower identity; orphaned active/uncertain records remain preserved until the paired owner explicitly reassigns the exact orphan target to a currently authenticated runtime.
8. Queue advancement occurs only after the active turn's durable delivery reaches a terminal or persisted uncertain disposition.
9. Restart-boundary bus duplicates are keyed across leader generations by profile, exact target, and request id; the current authenticated registration must own that target before reading or mutating the record.
10. The exact release tag commit passes the repository, architecture, audit, package, and public-export gates before a GitHub Release is created.

## 2. Non-goals

- No database, daemon, hosted queue, external storage service, PTY/process launcher, encryption/key-management system, or central multi-agent scheduler.
- No exactly-once claim for Pi execution, Telegram delivery, bus effects, or destructive remote calls.
- No second public bus switch and no hidden Pi subprocess.
- No blind cherry-pick or patch application from `eff2d10`, `bf76ab6`, or the dirty worktree.
- No redesign of rendering, thread naming, menus unrelated to the required controls, or public companion APIs.
- No native Windows live-test requirement. Existing Linux/macOS/Windows CI and portable named-pipe coverage remain regression gates.
- No npm publication.
- No use of `state.json`, logs, historical records, PID, or CWD alone as routing or recovery authority.

## 3. Frozen baseline, Git flow, and prerequisite semantic port

### 3.1 Authoritative baseline and integration flow

Fetched refs establish:

- `origin/dev = a674c55b5b24042b1d35c74d265acfed0a7c9cf8` (`0.24.2: context compression hotfix`).
- `origin/main = 1a1d4a67bfdeab2e7cd838c2dcfee36da369f518`, tag `v0.24.2`, merge PR `#141` from `llblab/dev`.
- Recent release PRs `#139`, `#140`, and `#141` establish `dev -> main` as the release promotion path.

All prerequisite, P0, and P1 feature branches are created from the current accepted `dev` head and target **`dev`**. After each merge, the next branch starts from the newly fetched `origin/dev`. The final release PR is **`dev -> main`**. Never target feature PRs directly at `main`.

If `origin/dev` moves before implementation starts, first rebase the plan evidence onto the new head and re-run the upstream disposition scan; do not silently apply this contract to an unreviewed baseline. Once implementation starts, each PR records its exact base and head SHA.

### 3.2 Preserve evidence; port semantics, not commits

The original custom worktree is `bf76ab6` with user-owned modifications to `CHANGELOG.md`, `lib/queue.ts`, and `tests/queue.test.ts`. Its binary diff SHA-256 is:

```text
b28d538d6f6b229cd64b600874a78b97c5909d210b8cc1cfad90f0d994ea75c7
```

Before creating an implementation worktree:

1. Save `git diff --binary` outside the repository as a private evidence artifact.
2. Verify `shasum -a 256` equals the hash above.
3. Record `git status --short`, `git rev-parse HEAD`, and the patch path in the implementation log.
4. Do not stage, reset, clean, cherry-pick, or modify the original worktree. In particular, do not remove `.pi-subagents/` or `plans/` from it.
5. Create the implementation worktree from `origin/dev@a674c55`.
6. Copy this exact reviewed plan into that worktree, verify its SHA-256, and include it in the prerequisite PR so subsequent workers and reviewers use one durable contract. Do not treat the stale custom worktree as the only copy.

Do **not** cherry-pick `eff2d10` or `bf76ab6`, and do not run `git apply` on the dirty patch. Reimplement and test these three intended behaviors against the current architecture:

| Ported behavior | Frozen contract | Current-domain landing points and tests |
| --- | --- | --- |
| Model menu default | Open on all authenticated models; scoped models remain an optional convenience view. Preserve scoped thinking metadata when the same canonical model appears in the all-model view. | Current model/menu domains; `tests/menu.test.ts`, `tests/integration.test.ts`. |
| Terminal status | Keep the fork rule that the `telegram` terminal extension status key is cleared; Telegram status surfaces remain available. | Current status/binding composition; `tests/status.test.ts`, `tests/bindings.test.ts`. |
| Dirty queue fix | After typing cleanup, ignore only a stale-context status failure; surface every non-stale status error. Generation-bind asynchronous queue-control settlement so an old callback cannot update status or dispatch through a replaced lifecycle context. Recreate the dirty tests from the saved patch against current queue/session-generation architecture. | `lib/queue.ts`, `tests/queue.test.ts`, current changelog entry. |

Telegram `/new` is explicitly excluded from this release by operator decision on 2026-07-22. The public Pi callback context has no safe session-replacement API; do not add a hidden command trampoline, unsafe cast, synthetic input, raw TTY control, or shadow process. Do not claim `/new` support in docs or release notes.

### 3.3 Prerequisite PR and gate

Land the semantic port and the validation audit policy as a focused prerequisite PR to `dev` before P0. A clean `npm ci` on `a674c55` reports exactly two root advisories fixed inside the published Pi dependency's own shrinkwrap: `brace-expansion@5.0.6` / source `1123898` / `GHSA-3jxr-9vmj-r5cp` (high) and `protobufjs@7.6.4` / source `1123964` / `GHSA-j3f2-48v5-ccww` (moderate). Consumer overrides cannot replace those installed copies, and lockfile-only remediation is prohibited. By explicit operator approval on 2026-07-22, `npm run audit` may accept only those exact root advisories and their transitive parent findings through 2026-08-21. The policy must inspect actual installed package versions and the complete audit graph, pass normally when no advisory remains, and fail on any unknown source/GHSA/package/version/path, malformed audit output, command failure, or allowed finding remaining at/after `2026-08-22T00:00:00Z`. Record the expiry and upstream-shrinkwrap reason in `BACKLOG.md`, `CHANGELOG.md`, and release docs. Do not use `--force`, downgrade Pi, alter installed `node_modules`, or suppress `npm audit` output. Required focused commands on the prerequisite head:

```bash
node --experimental-strip-types --test tests/integration.test.ts tests/menu.test.ts tests/status.test.ts tests/queue.test.ts tests/dependency-audit.test.ts
npm run typecheck
npm run audit
npm run validate
SKILL_DIR=.agents/skills/domain-dag bash .agents/skills/domain-dag/scripts/validate-domain-dag.sh --root .
```

Run each focused command once; run the stale-context and stale queue-control generation cases 20 times with `PI_RELIABILITY_SEED=2026072201`. The test harness added by the PR must print the seed on failure. Merge only after independent review confirms generation invalidation and exact fail-closed audit behavior.

## 4. Complete finding disposition inventory

`FIXED UPSTREAM` means no implementation is planned; retain or add only a focused non-regression if the touched P0/P1 code could regress it. `RESIDUAL` identifies the owning slice below. `REJECTED/INVESTIGATE` gives the required evidence action and may not be silently promoted into implementation.

### 4.1 P0 and concurrency findings

| Finding / duplicate key | Disposition | Required evidence |
| --- | --- | --- |
| `transport-request-deadline` | **RESIDUAL P0-A** | Per-attempt connect/headers/body deadlines and composed cancellation. |
| `polling-heartbeat-without-loop`, bootstrap/persist/sleep escape | **RESIDUAL P0-A** | Generation-bound supervisor restarts or releases ownership; phase diagnostics. |
| `custom-transport-abort-listener` and abort-aware backoff | **RESIDUAL P0-A** | Listener cleanup and abort-during-delay regressions. |
| `inbound-offset-durability` | **RESIDUAL P0-C** | Durable inbox/admission before offset acknowledgement. |
| `final-delivery-outbox` | **RESIDUAL P0-D** | Durable final/attachment outbox and recovery. |
| First-contact proof pairing | **RESIDUAL P0-B** | Exact proof-of-possession contract and atomic claim. |
| `bus-restart-replay` | **RESIDUAL P0-E** | Extend current in-memory ledger across leader restart only. |
| `locks-transaction-read-check-write`, owner identity/generation, stale election | **FIXED UPSTREAM — regression-only** | Preserve `withTelegramFileTransaction`, expected-owner election, `commitIfOwned`, and owned epoch checks. No new lock protocol. |
| Unix socket endpoint publication, macOS socket path, Windows pipe behavior | **FIXED UPSTREAM — regression-only** | Preserve generation endpoint publication and existing OS matrix. No endpoint redesign. |
| Destructive leader epoch fences | **FIXED UPSTREAM — regression-only** | Preserve pre/between/post-call checks and stale-success rejection; document remaining remote-call race as uncertain. |
| Profile-scoped locks/endpoints/thread state | **FIXED UPSTREAM — regression-only** | New recovery stores and keys include profile; do not alter upstream mechanisms. |
| Follower dirty-state handling | **FIXED UPSTREAM — regression-only** | Preserve reload-on-nonowner and revision/commit fencing. |
| Stale session detached delivery/session generation | **FIXED UPSTREAM — regression-only** | Reuse current delivery/session generation, transport stamp, and inactive result. |
| Generic unsafe Telegram retries | **FIXED UPSTREAM — regression-only** | Preserve `retrySafety`/`TelegramApiCommitUnknownError`; no parallel retry framework. |
| Concurrent config persistence | **FIXED UPSTREAM — regression-only** | Pairing uses the existing serialized transaction/read-merge-write primitive; no second config store. |
| Direct-target authorization | **FIXED UPSTREAM — regression-only** | Preserve exact allowed chat/assigned target checks. No new allowlist contract. |
| Profile logs/reset ordering / cross-instance evidence loss | **RESIDUAL P1-B** | Replace shared scope-reset/one-`_prev` behavior with profile+instance append-only segments and unique rotation; transaction serialization alone does not preserve evidence. |
| Duplicate registration/old-process promotion | **FIXED UPSTREAM mechanism; P0-C identity regression** | Two-follower and old/new-process tests prove current generation/registration fencing plus frozen recovery identity. |
| `queue-control-stale-context` | **RESIDUAL prerequisite S0** | Generation-bind control completion callbacks; after shutdown/session replacement, old settlement must update neither status nor dispatch through captured old context. |

### 4.2 P1, security, repository, and quality findings

| Finding / duplicate key | Disposition | Required evidence |
| --- | --- | --- |
| `reply-dedup-send-failure-poisoning` | **RESIDUAL P1-A** | Commit dedup only after confirmed send; pending/uncertain is durable. |
| `guest-rich-first-chunk-truncation` | **RESIDUAL P1-A** | One cached-document `answerGuestQuery` fallback contains full Markdown/text; caption says `Full response attached.` |
| `agent-end-delivery-queue-stall` | **RESIDUAL P1-A** | All final/error/attachment branches advance only after persisted terminal/uncertain disposition. |
| `inbound-download-rollback`, configured/programmatic voice temp artifacts | **RESIDUAL P1-B** | Turn-scoped ownership and cleanup for inbound/media/voice temporary files. |
| `identity-response-validation` and whitespace token boundary | **RESIDUAL P1-B** | HTTP status plus runtime schema validation for `getMe`; finite positive bot id and valid optional username. |
| `update-handler-failure-observability` | **RESIDUAL P1-B** | Catch, isolate, and record redacted handler identity/error metadata. |
| `deleted-message-id-scope` | **RESIDUAL P1-B** | Exact profile/chat/thread or business-connection scope before queue/media removal. |
| `text-group-unhandled-dispatch-rejection` | **RESIDUAL P1-B** | Timer-owned rejection is recorded and receives a terminal disposition. |
| `dependency-audit-lockfile-vulnerabilities` | **RESIDUAL prerequisite S0 / operator-approved expiring exception** | Permit only source `1123898` (`brace-expansion@5.0.6`) and source `1123964` (`protobufjs@7.6.4`) plus their audit-graph parents through 2026-08-21; verify installed paths/versions, fail closed on every other finding or after expiry, and recheck on the exact release lockfile in P1-C. |
| `ci-release-validation-gate` | **RESIDUAL P1-C** | Exact-tag validation, consistent action majors, tarball import smoke. |
| OS CI matrix / native path coverage | **FIXED UPSTREAM — regression-only** | Keep Ubuntu/macOS/Windows Node `22.19.0`; do not add a native Windows live gate. |
| Shared/resettable diagnostics | **RESIDUAL P1-B** | Existing logs remain private/profile-scoped but still reset one shared file and overwrite one `_prev`; implement append-only instance segments plus metadata index/retention. |
| Public/private direct-delivery target authorization | **FIXED UPSTREAM — regression-only** | Existing exact target tests remain green. |
| Private-chat owner bypass | **REJECTED false positive** | Latest authorization/delivery path restricts normal behavior to the paired owner/transport role. Add secure-pairing tests for second private users; do not create a separate owner-auth redesign. |
| Internal new-session spoofing | **EXCLUDED BY OPERATOR DECISION** | Telegram `/new` is not ported in this release because the public callback context lacks a safe session-replacement API. No trampoline, cast, synthetic input, raw TTY control, or shadow process is permitted. |
| Optional bus secret / string comparison | **REJECTED for this scope** | Production assembly supplies authenticated local capability; no demonstrated timing exploit. Preserve auth tests. |
| Real Bot API integration gap | **ACCEPTED LIMITATION / release runtime gate** | Deterministic fixture tests plus separately approved live smoke; no credentials in CI. |
| `index.ts` size/churn, lint/format/coverage expansion | **REJECTED as independent finding** | Enforce current composition and typecheck/DAG rules only in touched code. |
| Stale compacting and `/new` docs | **RESIDUAL documentation in prerequisite/P1-C audit** | State that Telegram `/new` is unavailable/out of scope; verify no obsolete terminal compacting claim remains. |
| GitHub vs npm publication | **RESOLVED CONTRACT** | GitHub Release only; npm publication prohibited. |

## 5. Frozen durable recovery contract

### 5.1 Store boundary, privacy, quota, and retention

Add a cohesive versioned recovery domain (prefer `lib/recovery.ts` or separate `lib/inbox.ts`/`lib/outbox.ts` only if review demonstrates independent state machines). It uses existing profile path and file-transaction helpers. The store root is a profile-scoped `recovery-v1` directory under the existing private Telegram runtime directory:

- directory mode `0700`;
- every record, payload, snapshot, and attachment-spool file mode `0600`;
- no bot token, bus secret, raw payload, answer body, attachment bytes/path, chat id, or username in logs/status;
- status exposes counts, byte totals, age, state, stable redacted ids, profile label, and required action only.

Durable recovery is explicitly allowed to retain the **minimum full prompt/answer payload and attachment spool required for recovery**. This private at-rest retention must be documented in `README.md` and the delivery/recovery architecture doc before release.

The hard quota is **512 MiB per profile**, including records, full prompt/answer payloads, and operation-owned attachment spool. Admission computes/reserves the complete required bytes under the store transaction. If quota would be exceeded, fail closed before Telegram offset acknowledgement, leave the update retriable by Telegram, record a metadata-only operator error, and show remediation in `/telegram-status`. Do not partially admit the turn.

Retention rules:

- pending, pre-dispatch, `execution-uncertain`, `delivery-uncertain`, and `bus-uncertain` payloads are never TTL-deleted;
- delivered terminal payloads compact after 24 hours, preserving only metadata needed for dedup/audit;
- terminal-only metadata is retained for 7 days and bounded to 100,000 records / 64 MiB per profile, whichever limit is reached first; transaction-safe eviction removes oldest terminal-only metadata and never pending/uncertain records;
- bus terminal dedup metadata follows the same 7-day horizon, which is the maximum supported delayed client replay window; requests older than that are new operations and require a new request id;
- explicitly discarded payloads may be removed immediately after the discard transaction commits;
- operation-owned attachments are deleted only on terminal resolution or explicit discard;
- compaction is transaction/rename safe, refuses mid-file corruption, recovers a truncated tail with a metadata incident, and never converts uncertain to delivered/discarded.

### 5.2 State machines and replay semantics

Inbound states:

```text
observed -> admitted -> pre-dispatch -> dispatching
                                     -> completed
                                     -> execution-uncertain
          -> explicitly-discarded
```

- Durable idempotency key: `(profile, update_id)`; queue turns also receive a stable random `turnId` stored in the admission.
- The leader advances the offset only after the responsible local instance/follower returns a durable admission ACK. Socket receipt is not admission.
- Offset progression is contiguous-prefix only within each `getUpdates` batch: stop processing at the first update that lacks a durable admitted or terminal disposition, and never acknowledge a later `update_id` across that gap. Intentionally ignored, unauthorized, unsupported, or poison-skipped updates receive a lightweight durable terminal disposition before they can advance the prefix. Mixed-batch test `N admitted / N+1 quota-failed / N+2 otherwise valid` must leave the persisted offset at `N` and must not process/acknowledge `N+2`.
- `admitted` and `pre-dispatch` records are automatically replayable and deduplicated.
- Persist `dispatching` before invoking Pi. If the process/session is lost after that commit, recovery marks the item `execution-uncertain`; it never automatically calls Pi again.
- An explicit operator retry creates a new attempt linked to the original uncertain id and records the duplication warning; explicit discard is terminal. These are the only ways to resolve process-orphaned execution uncertainty.
- Fencing prevents a stale runtime from starting Pi or committing a result after ownership changes. It does not claim to stop Pi work already accepted across the race.

Outbound states:

```text
planned -> pending -> sending -> delivered
                            -> delivery-uncertain
                            -> retryable-pending (known not committed only)
        -> explicitly-discarded
```

- Durable idempotency key: stable `intentId` plus source `turnId` and exact authorized target identity.
- Persist the complete final Markdown/text and operation-owned attachment spool before the semantic result can leave the lifecycle boundary.
- Retry only when the existing Telegram API result proves not committed. A timeout, connection loss after write, malformed success, crash after send before durable confirmation, or `TelegramApiCommitUnknownError` becomes `delivery-uncertain` and is not automatically resent.
- Queue advancement waits for a committed `delivered`, `delivery-uncertain`, or `explicitly-discarded` disposition. It never advances merely because a background Promise was scheduled or logged.

Bus states use `pending`, `completed`, `bus-uncertain`, and `explicitly-discarded`. See P0-E.

### 5.3 Recovery identity and exact claim predicate

Automatic recovery uses current upstream identity sources, not a new global identity file:

1. profile name/token scope;
2. exact `TelegramTarget` (`chatId`, optional `threadId`);
3. latest current thread owner record (`leader` or `manual-follower`) and slot/name metadata;
4. current authenticated leader epoch or follower registration generation;
5. for session replacement in the same process, the existing authenticated short-lived handoff carrying the target and stable manual-follower identity.

Automatic claim is allowed only when the current live owner record and authenticated runtime registration match the record's profile + target + owner kind, or when a valid same-process handoff proves the old and new session generations for that exact identity/target. A consumed handoff is single-use and generation-bound.

A process-orphaned follower's `active`, `execution-uncertain`, `delivery-uncertain`, or `bus-uncertain` records remain preserved but unclaimed. Upstream derives `manualFollowerOwnerId` from parent-process birth identity and therefore cannot prove continuity after a full parent/process restart; the plan must not invent a durable-identity match. Recovery after that boundary is an explicit **target reassignment**, not identity continuation: the paired owner selects one redacted orphan target, confirms its uncertainty warning, and assigns all unresolved records for that exact `(profile, old-owner, target)` tuple to a currently authenticated leader/follower runtime that does not already own a conflicting target. Because thread ownership and recovery records are separate stores, reassignment is an idempotent fenced state machine, not a fictional cross-file transaction:

```text
requested -> binding-transfer-pending -> binding-transferred -> recovery-grant-committed
          -> cancelled-before-transfer | rollback-pending
```

1. Persist a reassignment intent containing profile, exact target, old owner, new authenticated runtime/registration generation, and the complete unresolved-record id set.
2. Block inbound routing, outbox delivery, bus-ledger access, and recovery actions for that tuple while the intent is nonterminal.
3. Through the existing leader/transport ownership fence, transfer and persist the thread binding to the new owner; retry idempotently if the persisted owner already matches the intent.
4. Re-read the binding, revalidate current runtime authentication/generation and exact target, then commit one target-level recovery grant covering exactly the captured unresolved ids. New later records cannot join the old grant implicitly.
5. Only after grant commit may the new runtime access/retry/discard those records. Crash before binding transfer may cancel safely; crash after transfer resumes forward to grant commit or uses an explicit rollback intent that restores the old binding only when no new owner activity occurred.

CWD is diagnostic only. Same-CWD plus profile is never sufficient. A mismatch or concurrent claim is denied without modifying either store.

Required identity tests: same-process reload reclaim; two followers with identical CWD but distinct targets/identities; full follower/parent restart with no handoff remains unclaimed; wrong target cannot claim; non-owner reassignment fails; crash/retry at every reassignment state boundary; exact unresolved-id set moves once; new records are excluded; collision and replayed handoff/reassignment fail closed.

### 5.4 Recovery controls and downgrade protocol

`/telegram-status` must show metadata-only counts for `pre-dispatch`, `execution-uncertain`, `pending delivery`, `delivery-uncertain`, `bus-uncertain`, quota usage, and oldest age. A narrow recovery submenu may own the actions, but the following explicit actions must exist and require confirmation:

- **Retry** one selected uncertain item, creating a linked attempt and warning that the prior effect may already have happened;
- **Discard** one selected item, atomically terminalizing it before payload/spool deletion;
- **Drain** all proven-safe pre-dispatch and known-not-committed pending work; drain never retries uncertain items;
- **Downgrade preflight** reports blockers and succeeds only with zero nonterminal records of every kind.

Installing/running an older version is prohibited while any pending, pre-dispatch, `execution-uncertain`, `delivery-uncertain`, or `bus-uncertain` record exists. Old code is not expected to detect the store. Downgrade is an exclusive runtime transition: first fence/stop polling, follower forwarding, queue dispatch, outbox creation, and recovery actions; then acquire the store transaction, recheck zero nonterminal records, atomically rename the closed `recovery-v1` directory to a timestamped `recovery-v1-quarantine-<timestamp>` backup, fsync the parent, and keep admission disabled until process exit or explicit cancel/restore. It never deletes the backup or reports safety while a new store can be recreated. Starting the new version again detects a quarantine plus absent active store and offers an explicit restore only if compatible.

Upgrade/downgrade tests cover admission racing preflight, crash before rename, after rename before parent fsync/report, failed rename, nonzero blocker refusal, clean quarantine, cancel/restore, and proof that polling/forwarding/outbox cannot recreate the store while downgrade mode is active. No permanent dual-reader or old-version shim is added.

## 6. Bounded fault inventories

Every fault test injects exactly one named point, prints `PI_RELIABILITY_SEED`, and asserts disk state, remote-call count, offset state, queue state, recovery action, and metadata-only diagnostics.

### 6.1 Crash boundaries

| ID | Boundary | Required post-restart result |
| --- | --- | --- |
| `IN-01` | update observed, before quota reservation | No local record; offset unacknowledged; Telegram may redeliver. |
| `IN-02` | payload/spool written, admission transaction not committed | Orphan temp removed/reconciled; offset unacknowledged. |
| `IN-03` | admission committed, before offset persistence/ACK | One admitted record; redelivery deduplicates; then offset may advance. |
| `IN-04` | offset committed, before in-memory queue materialization | One durable pre-dispatch item auto-rehydrates. |
| `IN-05` | pre-dispatch queue materialized, before dispatch claim | One auto-replayable item. |
| `IN-06` | `dispatching` committed, before Pi call | Recovery classifies conservatively as `execution-uncertain`; operator action required. |
| `IN-07` | Pi call begun/returned, before completed commit | `execution-uncertain`; no automatic Pi replay. |
| `IN-08` | completed commit, before cleanup/compaction | Completed once; terminal metadata retained. |
| `OUT-01` | `agent_end` hands the semantic answer to the extension, before outbox commit | Semantic completion is not acknowledged until the synchronous outbox commit succeeds. A hard crash before commit leaves the inbound item `dispatching` and recovery classifies it `execution-uncertain`; the volatile generated answer may be unrecoverable and is never claimed as durably completed. Process-kill/reopen test required. |
| `OUT-02` | pending intent committed, before send | Automatically eligible for send. |
| `OUT-03` | send started, known-not-committed failure | Returns to retryable pending under bounded policy. |
| `OUT-04` | remote commit may have happened, response absent | `delivery-uncertain`; no auto-resend. |
| `OUT-05` | confirmed response, before delivered commit | Conservative `delivery-uncertain`; explicit recovery only. |
| `OUT-06` | delivered commit, before queue advance | Recovery advances queue without resending. |
| `BUS-01` | authenticated envelope received, before durable pending | Client retry is admissible and deduplicated by stable key. |
| `BUS-02` | pending committed, before side effect | New leader resumes only if method is proven safe. |
| `BUS-03` | side effect begun, terminal result absent | `bus-uncertain`; new leader never replays ambiguous mutation. |
| `BUS-04` | terminal result committed, response lost | New leader returns recorded terminal result; effect count stays one. |
| `PAIR-01` | verifier checked, before config transaction commit | No paired user; same valid claim may retry. |
| `PAIR-02` | winner committed, before response | Winner remains paired; concurrent/replayed claim is denied. |
| `DOWN-01` | preflight succeeds, before quarantine rename | Active compatible store remains. |
| `DOWN-02` | quarantine rename committed, before report | Restart detects completed quarantine; no active records lost. |

### 6.2 Detached and asynchronous ownership inventory

The implementation audit must enumerate every `void` Promise, timer, retry sleep, and background callback in touched domains. The initial required inventory is:

| Site id | Current site | Required owner/disposition |
| --- | --- | --- |
| `ASYNC-POLL-01` | polling loop, config persistence, retry sleep | P0-A supervisor owns restart/release and records phase. |
| `ASYNC-FINAL-01` | `lib/bindings.ts` scheduled agent-end delivery | P0-D durable intent owns completion; generation remains upstream-fenced. |
| `ASYNC-TEXT-01` | `lib/text-groups.ts` delayed grouped dispatch | P1-B catches/records and preserves or terminalizes admission. |
| `ASYNC-MEDIA-01` | media-group/download handler callbacks | P1-B turn owner cleans only its files and records failure. |
| `ASYNC-CMD-01` | command confirmation/session replacement callbacks | Prerequisite generation + exact target owner; no stale context. |
| `ASYNC-CONTROL-01` | queue control `onSettled` callbacks | S0 captures session generation and refuses status/dispatch after replacement; old context is never invoked. |
| `ASYNC-BUS-01` | bus leader/follower background request handling | P0-E ledger owns terminal/uncertain result. |
| `ASYNC-UPDATE-01` | public update handler dispatch | P1-B isolates and records redacted failure. |

A slice may add an id when source inspection finds another site, but it may not use “audit all async work” as unbounded acceptance. The PR description includes the final finite table and the test covering each changed site.

## 7. Implementation slices and executable evidence

### Slice S0 — prerequisite semantic port and fault harness

**Outcome:** §3.2 behaviors are present on latest `dev`, and deterministic fault injection is available without shipping test-only policy.

**Work:** copy this reviewed plan into the fresh worktree and verify its hash; perform the three-behavior semantic port; generation-bind queue control completion callbacks so old `onSettled` work cannot call status or dispatch after lifecycle replacement; implement and test the exact expiring audit policy from §3.3; add a test-only fault controller keyed by the bounded ids in §6; define serializable recovery contracts and version `1`; update the `/new` exclusion, audit-expiry record, and durable-retention disclosure draft. Do not activate durable storage yet.

**Likely files:** this plan; current command/menu/model/status/binding/routing domains; package manifest/lockfile; `tests/commands.test.ts`, `tests/bindings.test.ts`, `tests/integration.test.ts`, `tests/queue.test.ts`, `tests/model.test.ts`, `tests/status.test.ts`; create the currently absent `tests/menu-model.test.ts` as the mirrored suite for changed `lib/menu-model.ts`; new recovery contract and mirrored test only if needed.

**Commands:** §3.3 commands. Baseline failures run in a disposable `a674c55` probe; green tests are committed. Repeat stale-status and `session shutdown/rebind -> old control onSettled` generation cases 20 times with seed `2026072201`; the old callback must invoke neither old/new status nor dispatch. The prerequisite PR cannot merge while `npm run audit` or `npm run validate` is red under the exact expiring policy.

### P0-A — API deadlines and poll supervisor/release coupling

**Outcome:** no API attempt is unbounded, and a dead polling loop cannot coexist indefinitely with a healthy ownership heartbeat.

**Work:**

- At the `telegram-api` membrane, compose caller cancellation with method-class deadlines covering DNS/connect, TLS, headers, and body consumption.
- `getUpdates` deadline = configured Telegram long-poll timeout + a fixed documented network grace; other reads and mutations use explicit bounded class defaults. Preserve caller abort as abort, deadline as timeout, and current retry-safety classification.
- Remove transport abort listeners on every settlement and make retry delay cancellation-aware.
- Add a generation-bound polling supervisor with one active loop/controller. It catches bootstrap, offset persistence, body parse, and sleep failures; records phase/restart count/timestamps; applies bounded seeded jitter; restarts unexpected exits; and releases/stops ownership after the bounded restart budget or permanent auth/config failure. Explicit shutdown/ownership loss never restarts.
- Couple supervisor terminal failure to poll stop and transport lease release. Preserve current upstream ownership transaction; do not modify lock acquisition.

**Likely tests:** `tests/telegram-api.test.ts`, `tests/polling.test.ts`, `tests/integration.test.ts`, existing lock non-regressions.

**Focused commands:**

```bash
node --experimental-strip-types --test tests/telegram-api.test.ts tests/polling.test.ts
node --experimental-strip-types --test tests/integration.test.ts tests/locks.test.ts
for i in $(seq 1 50); do PI_RELIABILITY_SEED=2026072202 node --experimental-strip-types --test tests/polling.test.ts || exit 1; done
```

**Acceptance:** stalled connect, headers, and body each time out; stop settles; listener count returns to baseline; persistence/sleep rejection cannot leave heartbeat-only ownership; shutdown does not restart; current commit-unknown behavior remains unchanged.

### P0-B — secure pairing with atomic single winner

**Outcome:** unpaired bots cannot be claimed without local proof.

**Exact contract:**

- Existing valid `allowedUserId` is unchanged and no pairing code is generated.
- In unpaired state, before public update-handler dispatch and every normal command/menu/media/guest route, accept only an exact private-human text command `/start <code>`. Bots, groups, channels, edited messages, callbacks, reactions, attachments, service messages, and every other update are denied without side effects. Raw pairing proof and rejected unpaired updates are never exposed to public handlers, and handlers cannot consume/block a valid pairing claim. Paired-state handler ordering remains unchanged. Document this deliberate unpaired-only public-contract change in `docs/updates.md` and `docs/public-api.md`, with valid/invalid/paired handler-observation tests.
- `/telegram-setup` or `/telegram-connect` locally displays a cryptographically random single-use code. Persist only a salted cryptographic verifier, random salt, creation/expiry metadata, and **10-minute expiry**; never persist or log the code.
- Comparison uses the verifier. Success atomically stores the sender as `allowedUserId` and removes verifier/salt/expiry in the same config transaction.
- Use the latest upstream serialized config transaction. The transaction rereads latest state and compare-checks both unpaired state and verifier, so concurrent claims have one winner. Pairing atomicity is P0 and is not deferred.
- Maximum **five failed attempts per sender per rolling 10-minute window**. The limiter stores only sender id, timestamps/count, and expiry in private profile state; success/expiry clears applicable entries. Responses are generic and reveal neither code validity nor remaining attempts. No secret appears in status, state snapshots, errors, or diagnostics.

**Likely tests:** `tests/config.test.ts`, `tests/setup.test.ts`, `tests/updates.test.ts`, `tests/commands.test.ts`, `tests/integration.test.ts`.

**Focused commands:**

```bash
node --experimental-strip-types --test tests/config.test.ts tests/setup.test.ts tests/updates.test.ts tests/commands.test.ts
for i in $(seq 1 50); do PI_RELIABILITY_SEED=2026072203 node --experimental-strip-types --test tests/integration.test.ts || exit 1; done
```

**Acceptance:** exact command only; expiry; five-attempt limit; two simultaneous valid senders yield one persisted winner; config race preserves unrelated fields; restart preserves verifier but not code; existing paired configuration is unchanged; no secret leakage.

### P0-C — durable inbound inbox and queue admission

**Outcome:** offsets advance only after durable admission; safe work recovers; ambiguous Pi execution is not replayed.

**Work:** implement §§5.1–5.4 inbound states, quota, recovery identity, recovery controls, and downgrade marker; make follower ACK mean durable admission; remove duplicate offset authority if the recovery store supersedes config offset writes. Reuse latest target/thread owner records and same-process handoff.

**Likely files/tests:** recovery/inbox domain and `tests/recovery.test.ts` (or mirrored names); `lib/polling.ts`, `lib/queue.ts`, `lib/updates.ts`, bus admission ports, current turns/target owners; `tests/polling.test.ts`, `tests/queue.test.ts`, `tests/updates.test.ts`, `tests/bus-leader.test.ts`, `tests/bus-follower.test.ts`, `tests/integration.test.ts`.

**Focused commands:**

```bash
node --experimental-strip-types --test tests/recovery.test.ts tests/polling.test.ts tests/queue.test.ts tests/updates.test.ts
node --experimental-strip-types --test tests/bus-leader.test.ts tests/bus-follower.test.ts tests/integration.test.ts
for i in $(seq 1 50); do PI_RELIABILITY_SEED=2026072204 node --experimental-strip-types --test tests/recovery.test.ts || exit 1; done
```

If the owning module is split, replace `tests/recovery.test.ts` with the exact mirrored inbox/outbox test names in the PR commands.

**Acceptance:** all `IN-*`, identity, quota, corruption, retention, claim, and `DOWN-*` cases pass; same-CWD two-follower process tests cannot cross-claim; `IN-06/07` never auto-replay; status contains metadata only; modes are `0700/0600`.

### P0-D — durable outbound outbox/final delivery

**Outcome:** semantic completion survives restart, and every delivery gets a durable terminal or uncertain disposition before queue advancement.

**Work:** implement outbound state machine and full answer/attachment spool; bind execution to current authorized target and upstream transport/session generation; preserve preview/final ordering and partial delivery handles; route `TelegramApiCommitUnknownError` directly to `delivery-uncertain`; implement recovery controls and 24-hour terminal compaction.

**Likely tests:** mirrored recovery/outbox test; `tests/delivery.test.ts`, `tests/queue.test.ts`, `tests/replies.test.ts`, `tests/bindings.test.ts`, `tests/preview.test.ts`, `tests/outbound-attachments.test.ts`, `tests/integration.test.ts`.

**Focused commands:**

```bash
node --experimental-strip-types --test tests/recovery.test.ts tests/delivery.test.ts tests/queue.test.ts tests/bindings.test.ts
node --experimental-strip-types --test tests/replies.test.ts tests/preview.test.ts tests/outbound-attachments.test.ts tests/integration.test.ts
for i in $(seq 1 50); do PI_RELIABILITY_SEED=2026072205 node --experimental-strip-types --test tests/recovery.test.ts tests/queue.test.ts || exit 1; done
```

**Acceptance:** every `OUT-*` case passes; pending final recovers once; ambiguous send never auto-replays; exact reply/thread/profile/owner target survives; attachments remain until resolution; next turn waits for persisted delivered/uncertain/discarded state; old session callbacks cannot mutate the new session.

### P0-E — restart-boundary bus replay protection

**Outcome:** current in-memory duplicate suppression remains fast, while leader restart cannot replay ambiguous side effects.

**Exact contract:**

- Do not replace or weaken the current in-memory `requestLedger`.
- Add the restart-boundary key `(profile, exact target, requestId)`. The accepting leader generation and then-current authenticated registration identity are metadata, not part of the dedup key. Every lookup/resume first proves the current authenticated registration owns that exact target; a full-restart target reassignment follows §5.3 before access. Bind a payload fingerprint to the key; collision is denied and recorded.
- Persist pending before a side effect and terminal result before responding. Never store bus secrets or large attachment bodies in the ledger; use recovery payload references where required.
- A new leader returns a recorded terminal result, resumes only a pending operation proven safe by the current Telegram retry-safety/method policy, and otherwise writes/returns `bus-uncertain`. It never replays an ambiguous non-idempotent mutation.
- Revalidate current leader epoch before local start and before result commit. A remote call racing takeover may still become uncertain; do not claim strict remote fencing.
- Retention follows §5.1; terminal dedup metadata remains long enough to cover the 24-hour payload compaction window.

**Likely tests:** `tests/bus.test.ts`, `tests/bus-api.test.ts`, `tests/bus-leader.test.ts`, `tests/bus-follower.test.ts`, recovery test, `tests/thread-reconciler.test.ts`, `tests/integration.test.ts`.

**Focused commands:**

```bash
node --experimental-strip-types --test tests/bus.test.ts tests/bus-api.test.ts tests/bus-leader.test.ts tests/bus-follower.test.ts
node --experimental-strip-types --test tests/thread-reconciler.test.ts tests/recovery.test.ts tests/integration.test.ts
for i in $(seq 1 100); do PI_RELIABILITY_SEED=2026072206 node --experimental-strip-types --test tests/bus.test.ts tests/bus-leader.test.ts || exit 1; done
```

**Acceptance:** all `BUS-*` cases pass across actual server close/reopen fixtures; same request after generation change returns terminal result or uncertain without duplicate mutation; profile/target/follower mismatch cannot hit the record; current endpoint, election, and destructive-epoch tests remain green.

### P0 integration gate and merge

Create one stacked `reliability/p0-integration` branch from the prerequisite-merged `origin/dev`. Land P0-A through P0-E as reviewable commits on that branch; each slice must pass its focused gate before the next starts, but no slice is merged separately. Run §9's aggregate gate on the exact final P0 integration SHA and run the following process fixture 20 times with seed `2026072207`: two same-CWD followers, registration, leader death/promotion, response loss, same-process reload, full follower/parent restart, inbox/outbox reopen, uncertain target reassignment, and no unauthorized claim. Independent reviewers cover (1) durability/concurrency, (2) authorization/privacy, and (3) Flat Domain DAG/compatibility. Open one P0 PR from that tested branch to `dev`, merge only that exact reviewed head, fetch `origin/dev`, and verify it contains the tested P0 head. If merge policy creates a new commit, rerun the aggregate gate on `origin/dev`; corrective PRs remain P0 and must finish before P1 starts.

### P1-A — reply dedup, complete Guest reply, and queue disposition hardening

**Outcome:** retry metadata is correct, long Guest answers are complete, and all delivery branches obey the durable queue gate.

**Work:**

- Change reply dedup to pending/confirmed semantics: commit the dedup marker only after confirmed send. A known failure releases pending; commit-unknown maps to durable uncertain and does not pretend confirmed.
- Before creating Guest fallback documents, add the narrow operation-owned temporary-file primitive in P1-A. For a Guest answer that exceeds the one-result Rich Markdown/caption limit, create one private operation-owned document containing the **complete Markdown/text**, reuse the existing paired-owner staging upload and Telegram `file_id` pipeline, and call `answerGuestQuery` with one cached-document-compatible result. Caption is exactly `Full response attached.` The document is not truncated and P1-A cleans it after terminal resolution; P1-B generalizes the same primitive to other media/voice paths.
- Enumerate final text, error, attachment-only, voice, partial attachment, and Guest branches; each must persist delivered/uncertain/discarded before advancing. A thrown sender cannot strand or prematurely advance the queue.

**Likely tests:** `tests/replies.test.ts`, `tests/queue.test.ts`, `tests/delivery.test.ts`, `tests/outbound-attachments.test.ts`, `tests/integration.test.ts`.

**Commands:**

```bash
node --experimental-strip-types --test tests/replies.test.ts tests/queue.test.ts tests/delivery.test.ts tests/outbound-attachments.test.ts
for i in $(seq 1 30); do PI_RELIABILITY_SEED=2026072208 node --experimental-strip-types --test tests/replies.test.ts tests/queue.test.ts || exit 1; done
```

### P1-B — turn-scoped cleanup, setup validation, handler evidence, and deletion scope

**Outcome:** temp files have one owner, malformed identity cannot persist, public handler failures are visible, business deletion cannot cross target/profile boundaries, and one process cannot erase another process's incident evidence.

**Work:**

- Introduce turn/operation-scoped cleanup ownership for successfully downloaded inbound files, media groups, reply attachments, configured voice outputs, and provider-created voice files. Transfer ownership explicitly when a file enters durable spool; otherwise `finally` removes only files created by that operation on success/failure/cancel. Never delete a provider path not declared operation-owned.
- `getMe` validates HTTP success and runtime schema before persistence: object response, `ok === true`, result object, finite positive integer `id`, and optional `username` string satisfying Telegram username expectations. Trim token before empty validation.
- Public update-handler errors remain isolated but record handler id/category and sanitized error only; never record update/prompt payload.
- `deleted_business_messages` removal requires exact effective profile plus payload chat/business identity and any represented thread target. Scope queue and media-group removal by that identity; an update from another chat/profile cannot remove colliding `message_id` values.
- Replace profile-shared scope-reset logs with append-only profile+instance segments. Startup/scope changes append boundary records instead of truncating. Each active segment carries a writer-generation lease refreshed by that live process; size rotation atomically closes the current segment and creates a uniquely named successor, never overwriting a single `_prev`. On startup and bounded write/housekeeping triggers, the profile transaction reclassifies a segment as abandoned only when its writer lease is stale and process identity is not alive. Retention is exactly 14 days, at most 100 total segments, and at most 100 MiB per profile, counting live and abandoned active segments. Cleanup removes oldest closed/abandoned segments, never a verifiably live active segment, and records cleanup failure in the in-memory/status ring. If verifiably live active segments alone reach the hard byte cap, new diagnostic events are dropped with one in-memory/status overflow incident rather than deleting live evidence or affecting runtime behavior. Recovery state, not logs, remains authority for unresolved work. Preserve `0700/0600`, redaction, and transaction-safe concurrent writers. Add rotation, two-live-writer, repeated-dead-writer, stale-active reclassification, retention, total-cap, overflow, and cleanup-failure tests.
- Close `ASYNC-TEXT-01`, `ASYNC-MEDIA-01`, and `ASYNC-UPDATE-01` with named tests.

**Likely tests:** `tests/media.test.ts`, `tests/outbound-voice.test.ts`, `tests/telegram-api.test.ts`, `tests/setup.test.ts`, `tests/updates.test.ts`, `tests/text-groups.test.ts`, `tests/logs.test.ts`, `tests/integration.test.ts`.

**Commands:**

```bash
node --experimental-strip-types --test tests/media.test.ts tests/outbound-voice.test.ts tests/telegram-api.test.ts tests/setup.test.ts
node --experimental-strip-types --test tests/updates.test.ts tests/text-groups.test.ts tests/logs.test.ts tests/integration.test.ts
for i in $(seq 1 30); do PI_RELIABILITY_SEED=2026072209 node --experimental-strip-types --test tests/media.test.ts tests/updates.test.ts tests/logs.test.ts || exit 1; done
```

### P1-C — dependencies, exact-tag release workflow, package smoke, and documentation audit

**Outcome:** audit passes with zero findings or only the still-current, unexpired exact §3.3 exception, and a tag cannot create a GitHub Release without validation of that exact commit and package.

**Work:**

- Re-run `npm run audit` from a clean install on the exact release lockfile. Zero findings pass normally. If either approved Pi-shrinkwrap advisory remains, re-prove its exact source/GHSA/package/version/path, parent-only graph, and unexpired date; any new or changed advisory fails and must be fixed without `npm audit fix --force`, a Pi downgrade, or a broadened exception.
- Refactor/reuse workflow validation so the release job validates the exact tag SHA with Node `22.19.0`: clean `npm ci`, typecheck, tests, audit, pack, Domain DAG, and public-export tarball import before `gh release create`.
- Keep Ubuntu/macOS/Windows validation. For pull requests, explicitly checkout `github.event.pull_request.head.sha`, print/record checked-out `HEAD`, and compare it to the intended reviewed head; do not rely on GitHub's synthetic merge ref as exact-head evidence. Make `actions/checkout` and `actions/setup-node` major versions consistent across validate/release workflows.
- Package smoke must install the generated `.tgz` in a fresh temporary package and import root plus every declared export (`inbound`, `outbound`, `delivery`, `activity`, `updates`, `commands`, `sections`, `status`, `voice`, `keyboard`) from the tarball, not the source checkout.
- Prepare the release-ready `0.25.0` manifest/lockfile/changelog as the final reviewed commit on `reliability/p1-integration`, using `npm version --no-git-tag-version 0.25.0` or an evidence-equivalent exact edit. Audit README/docs/AGENTS/changelog for private payload retention, quota/recovery actions, uncertain semantics, the explicit `/new` exclusion, the expiring dependency exception, GitHub-only release, no stale compacting label, and public API accuracy.

**Likely tests/files:** workflow files, manifests/lockfile, `tests/public-api.test.ts`, `tests/invariants.test.ts`, relevant docs.

**Commands:** §9 complete gate plus an isolated workflow syntax/release-notes fixture. The PR records advisory ids before/after and tarball import output.

### P1 integration gate and merge

Create one stacked `reliability/p1-integration` branch from the P0-merged `origin/dev`. Land P1-A through P1-C as reviewable commits, each with its focused gate. Run §9 on the exact final P1 integration SHA, plus all P1 focused tests 20 times with seed `2026072210`. Independent reviewers cover (1) privacy/error cleanup, (2) public API and package artifact, and (3) CI/release security. Resolve every blocker/correction, rerun affected focused tests, then rerun the complete gate. Open one P1 PR to `dev`, merge only the tested head, fetch `origin/dev`, and rerun the aggregate gate there if merge policy creates a distinct commit.

## 8. PR, merge, release, and rollback procedure

1. Before any push, run `gh auth status`, `gh repo view --json nameWithOwner,defaultBranchRef`, and a read-only repository permission query. Confirm the authenticated identity can push branches, create/merge PRs, and create releases. Stop on missing permission without claiming completion.
2. Use exactly three pre-release branches unless a reviewed correction requires otherwise: `reliability/custom-port` for S0, `reliability/p0-integration` for stacked P0-A..E commits, and `reliability/p1-integration` for stacked P1-A..C commits. Never mix P0 and P1 or change their order.
3. Each of the three feature PRs targets `dev`, identifies base/head SHA, lists finding rows closed, includes focused/full command evidence and review disposition, and merges only the validated aggregate head. No force-push of reviewed heads.
4. The single P0 integration PR merges to `dev` after the P0 gate. The single P1 integration PR merges only after P0 is present and revalidated on `origin/dev`. Fetch and verify `origin/dev` after each merge.
5. P1-C prepares `0.25.0` as the final reviewed commit of `reliability/p1-integration`; the P1 aggregate gate and PR therefore include the manifest, both root lockfile version fields, consolidated `CHANGELOG.md`, workflows, and release docs. After the P1 PR merges, verify the resulting `origin/dev` still has all version fields at `0.25.0`. If `v0.25.0` already exists or baseline/version history changed, stop for a plan rebase rather than choosing another version silently.
6. Run the exact release gate on that release-ready `origin/dev`, then open the final PR **from `dev` to `main`**. Merge only after required checks and independent release review pass. Fetch the resulting `origin/main` merge commit, create a clean detached release worktree at that exact SHA, and rerun the complete §9 gate, tarball smoke, version/changelog checks, and sanitized diff/package inspection there. This post-merge `origin/main` SHA—not the pre-merge `dev` SHA—is the sole eligible tag target.
7. Before the live smoke, obtain exact target/content approval. Use fixed benign text and generated non-sensitive files; never use real private prompts or attachments. Smoke pairing on a disposable unpaired profile if available, normal prompt/final, leader/follower promotion, inbox/outbox restart, and Guest/voice only when safely configured. Telegram `/new` is not part of this release smoke.
8. Only after the clean post-merge gate passes, create and push annotated tag `v0.25.0` on that verified `origin/main` SHA. The tag workflow validates the same SHA again before creating the GitHub Release. Verify tag SHA, release target SHA, title, notes, and workflow conclusion.
9. Do not publish npm. A post-release load smoke may use the packed tarball or repository checkout at the tag in a safe Pi environment; do not claim an npm-installed `0.25.0` exists.
10. Remove only implementation-owned worktrees and temporary fixtures. Preserve the original custom worktree, patch evidence, quarantine backups, and all user-owned files.

Rollback rules:

- Before durable store activation, revert the focused PR normally.
- After activation, roll forward by default. Downgrade is permitted only through §5.4 zero-nonterminal preflight and atomic quarantine.
- Never delete or TTL-expire pending/uncertain payload to make rollback pass.
- A failed PR/release workflow changes no runtime recovery data. A mistaken unpushed tag may be corrected locally; a pushed tag/GitHub Release is not rewritten or deleted without new explicit authorization.

## 9. Complete validation gate

Run on Node **22.19.0 or newer**; CI and release use exactly `22.19.0`. Start from a clean implementation worktree with no staged files and install from lockfile:

```bash
node --version
npm ci
npm run typecheck
npm test
npm run audit
npm run pack:check
npm run validate
SKILL_DIR=.agents/skills/domain-dag bash .agents/skills/domain-dag/scripts/validate-domain-dag.sh --root .
```

`npm run validate` intentionally repeats core checks; both direct command evidence and the repository aggregate command must pass.

Tarball public-export smoke:

```bash
PACK_JSON="$(npm pack --json)"
PACK_FILE="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(x[0].filename)' "$PACK_JSON")"
SMOKE_DIR="$(mktemp -d)"
(
  cd "$SMOKE_DIR"
  npm init -y >/dev/null
  npm install --ignore-scripts "$OLDPWD/$PACK_FILE"
  node --experimental-strip-types --input-type=module - <<'NODE'
const paths = [
  "@llblab/pi-telegram",
  "@llblab/pi-telegram/inbound",
  "@llblab/pi-telegram/outbound",
  "@llblab/pi-telegram/delivery",
  "@llblab/pi-telegram/activity",
  "@llblab/pi-telegram/updates",
  "@llblab/pi-telegram/commands",
  "@llblab/pi-telegram/sections",
  "@llblab/pi-telegram/status",
  "@llblab/pi-telegram/voice",
  "@llblab/pi-telegram/keyboard",
];
for (const path of paths) await import(path);
console.log(`imported ${paths.length} public entrypoints`);
NODE
)
rm -rf "$SMOKE_DIR" "$PACK_FILE"
```

Also require:

- all focused slice commands and repeat counts/seeds in §7;
- Linux/macOS/Windows workflow success on the exact PR head;
- no secrets/private payloads in `git diff`, runtime logs, status snapshots, package contents, test snapshots, PR text, or release notes;
- package contents contain no recovery store, logs, patch evidence, `.pi-subagents`, temp files, or private ids;
- `git diff --check`, `git status --short`, and `git diff --cached --name-only` inspected before every commit/merge/tag;
- Domain DAG and `AGENTS.md` compliance pass recorded with any rule updates;
- exact release invariant for the annotated tag: validated SHA = `origin/main` release SHA = `git rev-parse 'v0.25.0^{commit}'` = GitHub Release target commit. The tag workflow prints checked-out `HEAD`, asserts it equals the peeled tag commit before validation, and records that commit SHA; the annotated tag object's own SHA is not compared to the commit SHA.

No flaky retry counts as evidence. A repeat failure records seed and fault id, is fixed, and restarts that slice's repeat run from iteration one.

## 10. Documentation and operator contract

Implementation PRs must keep these surfaces synchronized:

- `README.md`: private at-rest prompt/answer/attachment retention, 512 MiB/profile quota, recovery controls, explicit `/new` exclusion, expiring dependency exception, and GitHub-only release scope where relevant.
- `docs/architecture.md` and a focused delivery/recovery doc: state machines, at-least-once admission, uncertain semantics, identity claim, permissions, retention, downgrade.
- `docs/multi-instance-bus.md`: stable cross-generation dedup key and orphaned follower recovery.
- `docs/updates.md`: secure unpaired lane and public-handler failure diagnostics.
- `docs/outbound.md`: durable outbox, Guest cached-document fallback, reply dedup commit point.
- `docs/ui-style.md`: Telegram `/new` remains unavailable; recovery control labels follow existing menu conventions.
- `docs/public-api.md`: only if actual exported behavior changes; recovery internals remain package-private unless a reviewed requirement proves otherwise.
- `AGENTS.md`: durable recovery/uncertainty/privacy/downgrade rules and no exactly-once claims.
- `BACKLOG.md`: remove only fully completed owning tasks.
- `CHANGELOG.md`: final user/operator effects, not intermediate implementation churn.

## 11. Risks and mandatory mitigations

| Risk | Mandatory mitigation |
| --- | --- |
| Private payload retention surprises operators | Explicit docs; `0700/0600`; metadata-only status/logs; 512 MiB fail-closed quota; bounded terminal retention. |
| Pi/Telegram/bus duplicate effect after crash | Pre-dispatch only auto-replays; ambiguous effect becomes uncertain; retry/discard requires explicit confirmation. |
| Wrong follower claims recovery | Exact profile + target + owner kind + authenticated identity/generation; same-CWD forbidden; two-follower tests. |
| Upstream reliability mechanisms are duplicated/regressed | Reuse current config transaction, locks, endpoint publication, retry safety, session generation, target auth, and logs; regression-only disposition table. |
| Durable format traps downgrade | New-version preflight, zero-nonterminal requirement, atomic quarantine; old code is not trusted to detect format. |
| Storage exhaustion blocks bot | Fail before offset ACK and show actionable metadata-only operator error; never evict pending/uncertain. |
| Release advertises unvalidated artifact | Exact-tag workflow gate, action-version consistency, tarball import, SHA equality check. |
| Unauthorized external writes | Verify `gh` permissions before push/merge/tag/release; exact approval before Telegram smoke; npm publish prohibited. |
| Dirty custom work is lost | Save/hash evidence; use fresh upstream worktree; semantic port only; never mutate original worktree. |

## 12. Completion audit

Do not declare completion until every item has linked command/review/PR/release evidence:

- [ ] Original dirty patch saved privately and hash verified as `b28d538d6f6b229cd64b600874a78b97c5909d210b8cc1cfad90f0d994ea75c7`; original worktree unchanged.
- [ ] No cherry-pick or blind patch application from `eff2d10`/`bf76ab6`; four prerequisite behaviors are semantically ported and documented on current architecture.
- [ ] Prerequisite PR merged to `dev`; Telegram `/new` remains excluded with no unsafe workaround, and the exact two-advisory audit policy passes before its deadline.
- [ ] Every §4 row has the stated implementation/regression/rejection evidence.
- [ ] P0-A through P0-E focused commands, bounded fault ids, repeat counts, full gate, and three independent reviews pass.
- [ ] The single P0 integration PR is merged to `dev` before P1 integration begins, and the merged ref is revalidated if its SHA differs.
- [ ] P1-A through P1-C focused commands, repeats, full gate, and three independent reviews pass.
- [ ] The single P1 integration PR is merged to `dev`, and the merged ref is revalidated if its SHA differs.
- [ ] Recovery storage permissions, payload disclosure, quota, retention, identity, explicit recovery actions, and downgrade tests pass.
- [ ] `/telegram-status` exposes metadata-only counts/actions and never raw payload/secret/attachment data.
- [ ] Node 22.19 clean install, typecheck, full tests, exact expiring audit policy, pack, validate, Domain DAG, OS matrix, and tarball imports pass on exact release head; any still-present exception is before `2026-08-22T00:00:00Z` and unchanged.
- [ ] `dev -> main` release PR is merged and `main` contains the exact validated `dev` head.
- [ ] GitHub permission checks pass; live Telegram smoke has exact target/content approval and sanitized evidence.
- [ ] `package.json`, both root lockfile version fields, changelog, annotated tag `v0.25.0`, GitHub Release notes, validated SHA, peeled tag commit, and release target agree.
- [ ] GitHub Release exists and succeeded only after exact-tag validation.
- [ ] No npm publication occurred or was implied.
- [ ] Only implementation-owned temporary worktrees/artifacts were removed; user-owned files and recovery quarantine backups remain intact.

If an item lacks evidence, report the precise blocker, attempted checks, affected fault/finding ids, and the smallest external input required. Partial implementation, a green subset, or a GitHub Release without the exact-tag gate is not completion.
