# Telegram Bridge Architecture

## Purpose

`pi-telegram` is a session-aware Pi runtime extension that binds Telegram destinations to running Pi instances and routes each accepted prompt into the assigned instance's currently active session. It owns the Telegram bridge boundary:

- Poll Telegram updates and enforce single-user pairing.
- Translate Telegram text, callbacks, media, and files into Pi turns.
- Stream previews and deliver final Pi responses back to Telegram.
- Provide Telegram-native controls for queueing, model/thinking/settings menus, compaction, abort/stop, prompt templates, reactions, and outbound artifacts.

The bridge is a mobile companion for a live Pi runtime, not a remote terminal or session browser. It should let an operator start work in the TUI and continue supervising the instance's active session from Telegram, while staying inside Pi's extension-facing contracts.

This document is the architectural map. Focused behavior standards live in sibling docs:

- [Public API](./public-api.md) — stable commands, config, package entrypoints, assistant markup, extension APIs, and compatibility boundaries.
- [Telegram Delivery API](./delivery.md) — target-aware operational views, logical message handles, lifecycle fencing, and leader/follower transport.
- [Telegram Activity API](./activity.md) — normalized Pi lifecycle events, activity/source identity, non-blocking extension dispatch, and delivery contexts.
- [UI Style](./ui-style.md) — inline UI labels, navigation, state markers, cards, and dialogs.
- [Callback Namespaces](./callback-namespaces.md) — callback prefix ownership and fallback rules.
- [Sections](./sections.md) — structured Telegram menu sections.
- [Updates](./updates.md) — update classification, default-routing plans, and raw Telegram update interception.
- [Voice Integration](./voice.md) — voice reply policy and STT/TTS provider surface.
- [Command Templates](./command-templates.md) — shell-free command-template contract.
- [Telegram Multi-Instance Bus](./multi-instance-bus.md) — Threaded Mode bus leadership, Telegram UI thread targets, instance identity, and leader/follower routing.

## Runtime Topology

`index.ts` is the only composition root. It wires live Pi ports, Telegram Bot API ports, session-local stores, lifecycle hooks, and domain runtimes. It should operate at high-level domain-runtime boundaries: non-trivial Threaded Mode capability decisions, leader/follower recovery, sync-slice bookkeeping, manual thread cleanup, and bus routing policies belong in their owning `/lib` domains. Reusable logic lives in flat `/lib/*.ts` domain modules rather than a deep local module tree.

### Extension Boundary Vs Supervisor Control

`pi-telegram` runs inside the current Pi process as an extension. That gives it safe access to public extension APIs such as aborting work, compacting, dispatching queued prompts, observing lifecycle events, and rendering Telegram-native controls. It does not own the terminal, the interactive-mode chat transcript, or the process lifecycle.

Keep this boundary explicit:

- Do not use raw TTY injection, ANSI terminal clearing, private TUI container mutation, or a shadow `pi` subprocess to simulate interactive commands.
- Do not treat Telegram as a generic remote shell for every Pi slash command.
- Commands that require interactive session replacement or TUI rerendering, such as a true Telegram `/new`, need a public Pi API that invokes the same runtime path as the terminal command.
- A separate PTY supervisor or daemon could choose to own those risks, but that would be a different product mode rather than this extension's runtime contract.

### Instance, Session, And Context Cost

A Telegram destination follows a Pi instance, not an immutable Pi session file. Ordinary Telegram prompts enter whichever session is active in that assigned instance when dispatch occurs. If the operator replaces or resumes a session locally, pi-telegram rebinds its session-scoped runtime state while preserving the instance's Telegram target where supported. Telegram currently exposes compaction for the active session, but not new-session, resume, fork, tree navigation, session switching, or full reload; those operations require safe public Pi extension APIs.

`/telegram-connect` never launches a hidden or headless Pi process. A long-lived background Pi process can own Telegram only when something else explicitly launched that process and it satisfies the normal lock/runtime rules. Pi `print` and `json` modes stay passive and exit rather than becoming hidden polling owners.

Pi session JSONL and pi-telegram runtime JSONL serve different purposes. Pi session files contain model conversation, tool, usage, branch, and compaction entries. Profile-scoped `logs.jsonl` / `logs.<profile>.jsonl` contain redacted bridge operations from one or more instances and never become model context. Sharing a Telegram profile or working directory does not by itself merge Pi session identities or model histories.

A Telegram prompt is a normal Pi model turn. It inherits the active post-compaction context just like a TUI prompt in the same session; pi-telegram does not promise context isolation or token cost proportional only to the new message. Current prompt guidance uses a small transient system note and the on-demand `telegram_help` tool instead of persisting the former large guidance suffix in every user turn. Existing session files created by older versions may still contain those historical repeated suffixes until session replacement or compaction removes them from active context.

The repository uses a **Flat Domain DAG**:

- Local imports must form a directed acyclic graph.
- Cohesive domain files are preferred over atomizing every helper.
- Shared buckets such as `lib/constants.ts` or `lib/types.ts` are avoided.
- Constants and state types live with their owning domain.
- Narrow structural projections are allowed when they avoid importing broader runtime or wire DTOs.
- Source file headers include `Zones:` tags so cross-cutting responsibility stays visible without folder nesting.

### Domain Ownership Map

- `index.ts`: composition root for live ports, session-state ports, transport adapters, and lifecycle registration. It exposes cross-domain wiring but does not own mutable domain state or reusable adapters.
- `api`: Bot API helpers, retries, uploads/downloads, temp cleanup, byte limits, chat actions, lazy token clients, and API error recording.
- `config` / `setup`: `telegram.json`, bot token setup, named bot/session profiles, first-user pairing, authorization, env fallback, atomic persistence, effective config views, and live config accessors.
- `locks` / `polling`: extension-local transport owner storage, exact-owner epoch exposure, process-global reload generations, owner-aware polling lifecycle/takeover/follower registration, and the cohesive classic-vs-Threaded capability state/monitor/observation/polling orchestration. Polling also owns long-poll controller state, offset admission/persistence, and poll-loop wiring.
- `bus` / `bus-api` / `bus-leader` / `bus-follower` / `ownership` / `target`: Threaded Mode multi-instance bus contracts, profile-scoped process/endpoint identity, local leader/follower IPC, leader-only orchestration, follower-side manual registration/session runtime, follower-routed Bot API calls, live message ownership, and `{ chatId, threadId? }` target identity. `bus` owns shared protocol, process identity, profile-aware local endpoints, and IPC primitives; `bus-leader` owns leader runtime, leader envelope handling, activation scheduling, and leader polling/server/prune orchestration; `bus-follower` owns process-stable manual-follower keys plus this Pi instance's follower-side registration, heartbeat, one-sequence authenticated client assembly, forwarded-update adaptation/receiving, recovery retry defaults, and routed API caller without any process spawning.
- `sync`: demand-driven Telegram reconciliation, mutable sync-slice state, nested provisioning activity, and local assumption policy. It does not own a complete Telegram bot read-model; Bot API lacks a complete topic/thread listing surface. It owns sync slices, invalidation triggers, config-persist invalidation sequencing, stale-topic API recovery adaptation, observation intake, status/debug freshness, and reconciliation scheduling across bot identity, pairing assumptions, live target bindings, reservations, and transport health after meaningful observable signals. It should call narrower domain primitives rather than letting `index.ts`, `threads`, or `status` accumulate cross-cutting reconciliation policy.
- `thread-reconciler`: Threaded Mode control-plane planning for Telegram thread/tab lifecycle. It owns the reconciliation state machine (`stable`, `provisioning`, `sync-required`, `cleanup-required`), pure plans, proof-before-delete rules, pending-provision protection, fresh-creation grace windows, leader-epoch checks, and the single policy authority for destructive thread cleanup actions. It excludes live Telegram API calls, inbound routing, menu rendering, and direct persistence.
- `threads`: Telegram UI thread/tab binding state mapped to Bot API `message_thread_id` / `ForumTopic` transport. Owns leader and current-instance identity state, profile-bound same-process leader session handoff, status projections, slot allocation from the current extension state, baked compact thread-name selection, current binding persistence, and primitive thread provision helpers. It should not persist stale/offline/failed target history, own destructive cleanup policy, grow into the general Telegram synchronization domain, or expose a rename tool.
- `updates` / `routing`: update classification, authorization planning, callbacks, edited messages, reactions, target-owner forwarding, inbound bus ownership/live-target/local-label projection, and inbound route composition.
- `media` / `text-groups` / `time-injection` / `turns` / `inbound`: inbound text/media/file extraction, rich-message reply-context plaintext recovery, media-group debounce, long-text coalescing, optional `[time]` context, handler execution, and prompt-turn assembly/editing.
- `queue`: queue item contracts, profile/token transport-generation stamping, lane admission/order, readiness gates, mutations, dispatch runtime, prompt/control enqueueing, and session/agent/tool lifecycle sequencing.
- `runtime`: session-local coordination primitives: counters, flags, setup guard, abort handler, typing timers, dispatch flags, and reset binding.
- `model` / `menu-model` / `menu-thinking` / `menu-status` / `menu-queue` / `menu-settings` / `menu` / `commands`: model identity, thinking levels, scoped model handling, menu render/callback behavior, slash commands, bot commands, and interactive controls.
- `sections`: Telegram menu-section registry, opaque section callback tokens, render/callback dispatch, safe section ports, and diagnostics.
- `keyboard`: shared inline-keyboard reply-markup shape only; feature domains own labels, callback data, and behavior.
- `preview` / `replies` / `rendering`: throttled native Rich Markdown draft delivery, native final reply delivery, reply parameters, transport-limit chunking, and remaining Telegram HTML rendering for bridge-owned UI/compatibility surfaces.
- `delivery`: public extension operational-view delivery, active-turn/instance/aggregate/authorized target policy, logical chunk handles, per-target ordering, runtime generation fencing, and the process-local runtime membrane. Its bridge adapter composes the established UI/compat reply renderer with narrow bus-aware Telegram API and ownership ports; it never exposes bot clients or Pi contexts.
- `activity`: public normalized Pi lifecycle registration, activity/source identity, assistant segment and reasoning normalization, executed-tool events, non-blocking per-handler queues, delivery contexts, compatibility adapters, and shutdown fencing. The same domain extends assistant-output observation for proactive push: eligible completed local/autonomous public segments retain source order and deduplicate event identity. `bindings` assembles observation, authority, sender, and failure-projection ports; routing owns exact delivery authority, outbound composes established transformations and reply delivery, and Bot API domains implement transport. No separate proactive state-machine domain exists.
- `outbound-markup`: top-level assistant action comment parsing, attribute parsing, voice reply planning, and preview/delivery stripping.
- `outbound`: outbound text transformations, voice/button artifact delivery, and generated callback actions.
- `outbound-attachments`: `telegram_attach`, queued outbound files, stat/limit checks, ordinary photo/document delivery, and narrow single-artifact Rich Message planning/sending for probe-confirmed photo/video/audio formats. It owns known-failure fallback eligibility and ambiguous-send no-replay classification through structural error contracts without importing Bot API helpers.
- `status` / `logs`: status bar/status-message rendering, queue-lane summaries, the structural redacted event ring, profile-aware JSONL scope/reset/append behavior, exact-owner destructive commits, fail-soft synchronous and queued diagnostics persistence, status snapshot scheduling, and grouped diagnostics. `status` remains a structural leaf; `logs` composes filesystem evidence with status projections and contains every persistence failure so diagnostics cannot terminate or poison the runtime queue.
- `bindings` / `lifecycle` / `prompts` / `prompt-templates` / `pi`: Pi-facing command/tool/hook registration and cohesive cross-domain binding assembly; session-generation fencing and start/shutdown sequencing across Queue, grouped input, Delivery, polling, capability monitor, watchdog, follower refresh, and assistant-output projection; Telegram prompt guidance; prompt-template discovery/expansion; and centralized direct Pi SDK imports.
- `command-templates`: shell-free command-template helpers, composition expansion, placeholder substitution, executable resolution, warnings, and retry/timeout semantics.

### Guarded Invariants

Architecture invariant tests protect:

- Acyclic local imports.
- Direct Pi SDK imports centralized in the `pi` adapter.
- `index.ts` as a composition root without local runtime adapter logic.
- Runtime state isolation from local domain imports.
- Structural leaf-domain isolation.
- Menu/model boundary direction.
- API/config separation.
- Media/update/API decoupling.
- Outbound attachment isolation from queue, inbound media, and API helpers.

Mirrored domain regressions live in `/tests/*.test.ts`. Shared test fixtures should exist only when multiple suites genuinely reuse them.

## Configuration And Ownership

Telegram configuration lives in `~/.pi/agent/telegram.json`. Bot/session identity (`botToken`, `botUsername`, `botId`, `allowedUserId`, `lastUpdateId`) persists only under `profiles.default` or `profiles.<name>`; shared handlers and assistant/voice/time settings stay top-level. Authoritative transport ownership lives separately in the pi-telegram-private `~/.pi/agent/tmp/telegram/owners.json` store. Its top-level slots are `default` and validated named profile names; unrelated extensions never read or write this file.

`telegram.json` is one global cross-instance configuration document. Ordinary reads rely on atomic publication and do not take the mutation guard. Every cooperating Pi instance persists only its recursive delta from the snapshot it loaded, merges that delta into the latest disk document inside `telegram.json.transaction`, and publishes atomically only when the semantic result differs; a no-op merge adopts the newer disk snapshot in memory without replacing the file. Unrelated global and profile changes therefore survive stale writers, while `lastUpdateId` additionally merges monotonically. Two serialized writers changing the same leaf use commit order, so the later local delta wins. A non-transactional external editor cannot participate in that conflict protocol: it should write through same-directory atomic replacement while Pi is idle, then let instances reload; an editor racing the transaction may lose its same-leaf change and must retry from the resulting file.

### Setup Flow

`/telegram-setup` progressively resolves the bot token:

1. Use the locally saved token when present.
2. Otherwise use the first supported Telegram token environment variable.
3. Otherwise show the example placeholder.

`ctx.ui.input()` only supports placeholder text, so setup uses `ctx.ui.editor()` when a real default must appear already filled in. Bare and explicit `default` setup/connect commands address the same `profiles.default` entry. Persisted config is written through a private temp file plus atomic rename and left with `0600` permissions. On first load, legacy root identity moves into `profiles.default` in that same serialized atomic transaction when no conflicting canonical value exists; identical duplicates collapse, complementary fields merge, and conflicts reject the load without modifying the file.

### Runtime Ownership

- `/telegram-connect` acquires or moves the active profile's owner slot before polling starts. `/telegram-disconnect` stops polling and releases only that exact slot. In Threaded Mode disconnect first names the current thread in a destructive confirmation, then tears down the disconnecting instance's bound Telegram thread: leaders delete their own thread directly, and followers send an authenticated exact-generation disconnect envelope and wait for confirmed leader cleanup before unregistering. Unconfirmed cleanup keeps binding/routing state available for an explicit retry.
- Session start schedules polling resume asynchronously only when the owner slot already points at the current `pid`/`cwd`, or when a stale same-`cwd` owner can be safely replaced after process restart. Startup and `/resume` do not wait on leader election, Bot API probes, poller handoff, or thread reconciliation before restoring the Pi session.
- Pi `print`/`json` run modes stay passive. Inherited child sessions that share `telegram.json` but do not own the exact `pid`/`cwd` slot must not poll or call `getUpdates` unless the operator force-takes ownership.
- Session replacement suspends polling/watchers without releasing ownership so the next session in the same process can resume. A registered follower snapshots its assigned target into a short-lived same-process handoff, stops the old receiver/heartbeat, and re-registers through the live leader without marking or replacing its Telegram thread.
- Live external owners require explicit takeover confirmation. Long-lived timers compare against snapshotted owner identity and stop local transport work when the slot no longer matches.
- `owners.json` owns only Telegram transport control. Local extension and accepted queue state remain per Pi instance when ownership moves, but previews, final delivery, dispatch transport mutations, and delayed Bot API work fail closed until exact direct or follower authority becomes valid again.
- Exact ownership remains checked every second, while the durable owner heartbeat refresh runs every two seconds and becomes stale after eight seconds. This keeps replacement detection responsive while halving steady-state atomic `owners.json` rewrites without changing the cross-platform file-transaction authority. Every acquisition, refresh, release, takeover, and stale recovery serializes through the sibling `owners.json.transaction` guard. The guard publishes one private generation-named owner record atomically, validates filename/payload generation agreement, fences stale recovery and delayed release against replacement-owner ABA, and fails closed on malformed state, unverifiable ownership, contention timeout, or unsupported filesystem behavior. The JSON store publishes through a private same-directory temporary file and atomic rename; atomic payload replacement does not replace transaction serialization.
- `owners.json` is authoritative and private. `state.json` remains an observable snapshot, `logs.jsonl` remains diagnostics, and followers remain authenticated bus registrations rather than ownership-file writers.

### Persistence I/O Baseline

The three runtime files have different authority and write pressure. Preserve that distinction when optimizing them:

- `owners.json` is safety-critical transport authority. Acquire, release, takeover, stale recovery, and two-second leader lease refresh mutate it. The steady-state baseline is one cached atomic rewrite every two seconds per active profile, or 43,200 refreshes/day; one-second ownership checks are read-only. Every mutation serializes the full cross-process read/check/write through `owners.json.transaction`.
- `state.json` combines recovery-critical thread/capability state with observational runtime projections. Every explicit thread-store `persist()` builds a semantic snapshot, but an unchanged payload skips temporary-file creation and rename after ignoring `writtenAtMs`; changed snapshots retain the full atomic replacement path. Diagnostics scheduling coalesces requests across a bounded 100 ms window. Only the exact transport owner commits; non-owners reload current disk state instead of publishing.
- `logs.jsonl` is fail-soft observational evidence, never routing authority. Runtime events admitted in one JavaScript turn batch by captured profile path into one size check, one profile-wide file transaction, and one append while preserving event order. Batching adds no timer or shutdown-loss window; separate profiles remain isolated, and one failed group does not drop another. Scope reset and rotation retain their serialized copy/replace path. The 5 MiB value is a rotation threshold: an authorized writer rotates between batched records before the next record crosses it, so overshoot is bounded to one admitted record plus reset metadata; a writer without reset authority defers rotation to the owner.

This baseline counts write-producing code paths rather than filesystem implementation details that vary between ext4, APFS, NTFS, and network-backed home directories. Optimization evidence should compare these deterministic triggers first, then use platform smoke evidence for rename, named-pipe, crash, and cleanup behavior. Recovery-critical `state.json` fields are `bot`, `identities`, `reservations`, `pendingProvisions`, `syncObservations`, and `threads`; `runtime`, `liveRoster`, `diagnostics`, and `writtenAtMs` are observational and may use bounded coalescing when authority checks remain unchanged.

Version `0.24.0` intentionally does not read or migrate the former agent-level `locks.json`; upgrading resets Telegram ownership. Run `/telegram-connect` when a fresh owner is not elected automatically. Delete `~/.pi/agent/tmp/telegram/owners.json` and its stale transaction guard, when no owner process is live, to reset only pi-telegram transport ownership without deleting configuration, diagnostics, or other extensions' state.

### Threaded Mode Multi-Instance Bus

Telegram private-chat Threaded Mode is the public switch for multi-instance Telegram operation. Classic single-DM polling is the base mode. When Telegram private-chat threads are available for the bot, the bridge enables the local leader/follower bus automatically; when threads are unavailable or later disabled, the bridge returns to classic single-DM polling as a first-class mode.

Named Telegram profiles are orthogonal to Threaded Mode. The selected profile chooses the bot/session slice (`botToken`, `botId`, `botUsername`, `allowedUserId`, `lastUpdateId`) and scopes the `owners.json` slot, diagnostics logs, state files, thread/bus ownership, and leader/follower IPC endpoints; it must not change the Threaded Mode rules. Within one selected profile, leader/follower election, bus transport, thread provisioning, routing, ownership forwarding, cleanup, and runtime diagnostics behave exactly as they do for the `default` slot. A different selected profile is a parallel bot runtime: its owner slot, `tmp/telegram/state.<profile>.json`, `tmp/telegram/logs.<profile>.jsonl`, `tmp/telegram/logs.<profile>._prev.jsonl`, thread bindings, Unix sockets, and Windows named pipes are isolated from the default profile and other named profiles while shared bridge settings remain top-level/global.

Profile reality follows three explicit storage classes. `telegram.json` shared settings and extension registries are process-global platform configuration; `profiles.default` and `profiles.<name>` bot/session fields plus observable transport/routing authority are profile-scoped; queues, active turns, ownership caches, menu state, and runtime controllers are session-local memory. Config persistence serializes cross-process writers and applies each recursive mutation delta to the latest disk snapshot, so named-profile offsets and unrelated global/profile updates do not stale-replace one another. Polling publishes only its monotonic `lastUpdateId` into the current config-store snapshot; it never persists the detached full config object captured at poll start, which would interpret newer Settings fields as deletions. Runtime profile switching follows stop-old/commit-new ordering: reload keeps the selected identity stable, old polling/lock/bus teardown finishes while all dynamic resolvers still point at the old profile, and only then may activation expose the new token, lock key, state path, target namespace, and IPC endpoint. Downloaded attachments use UUID-prefixed names in the shared Telegram scratch directory and are session artifacts rather than identity or routing authority, so cross-profile cleanup is limited to stale scratch files and cannot redirect live traffic.

When Threaded Mode is active, the current polling owner is also the Telegram bus leader. The leader owns the local bus endpoint (Unix-domain socket on Unix-like platforms, named pipe on native Windows), polls `getUpdates`, performs direct Bot API calls, records follower heartbeats, prunes stale followers, and provisions Telegram UI thread targets through live runtime/bus state. Follower liveness is intentionally fast because heartbeat traffic is local IPC: followers heartbeat every `1s`, the leader treats them as stale after `2s`, and the prune loop runs every `1s` so stopped followers are detected promptly while active forwarded updates/API calls still refresh liveness. Heartbeat pruning is silent liveness bookkeeping: it preserves the follower thread binding and does not send a Telegram-visible disconnected notice, because the common cause may be leader reload or IPC handoff rather than a dead follower. Successful follower target reuse refreshes the binding's recovery timestamp. Absent follower bindings remain durable restoration hints until explicit stale, deleted, offline, or reconciliation evidence invalidates them; process absence and heartbeat pruning alone do not remove them. If an authenticated live follower carries an exact target that is absent from current bindings, the leader recovers it only behind a synchronous visibility probe: success activates it, explicit stale evidence provisions a replacement, and ambiguous failure rejects registration. A carried slot is restored only when it is not already occupied. `tmp/telegram/logs.jsonl` is a session-local redacted runtime evidence stream for race debugging; it resets on extension start and runtime scope changes, and must not become routing/provisioning authority. `tmp/telegram/state.json` is an extension+bot observable/debug snapshot aligned with status diagnostics: `source: "snapshot"` and `writtenAtMs` mark it as observational, not authoritative. All instances on one Telegram profile read the same snapshot, but only the active transport lock owner persists it; followers become writers only after promotion. Status-only persistence reloads current disk bindings before serialization, preventing a stale follower/status view from erasing newer leader-owned targets. Fresh capability observations may skip redundant startup probes, but stale snapshots re-probe before suppressing bus/thread behavior. Top-level `bot` mirrors bot-wide capabilities such as thread mode, `runtime` describes process role/status, `liveRoster` mirrors followers/current targets/reservations, `diagnostics` mirrors recent status/debug signals including the latest thread-reconciler phase/counts, `threads` stores current routeable bindings, TTL-bounded reservations explain short-lived slot collision guards, and TTL-pruned `pendingProvisions` protects in-flight topic creation slots from cleanup/allocation races. Fresh provisioning writes pending state before the Bot API create call, adds the returned target to the pending record, persists a `starting` binding, then promotes it to `active` and clears pending state. If final binding persistence fails after Telegram returns a thread id, the targeted pending provision remains as cleanup/retry evidence. Once targeted pending provisions expire, they are retained for `thread-reconciler` close/delete cleanup and pending scratchpad removal after a successful cleanup apply; untargeted expired pending records can prune without cleanup because no Telegram thread id exists. Runtime events coalesce status-snapshot writes so transient bus/API/update failures remain inspectable even when the operator has not opened `/telegram-status`. The bridge must not keep a durable `telegram-targets.json` target history; stale/offline/failed thread observations are pruned instead of reused. Previous-process leader bindings that still probe alive become reservations/collision guards, not routeable active threads, so a reloaded leader can take the next free slot without duplicating the same visible tab name. The thread chat is always the private bot DM with the paired owner (`allowedUserId`). In Telegram private-chat Threaded Mode, the leader creates/reuses its own thread before polling — it is a real bound instance, not a dispatcher. Followers authenticate bus envelopes with the leader-minted capability secret stored in the active lock entry. Leader lock entries also carry a stable `leaderEpoch` minted on acquisition and preserved across heartbeat refreshes; leader-owned cleanup/provisioning plans stamp that epoch, and Thread Reconciler apply skips destructive work if leadership has moved on before side effects run. Followers own their own Pi session state, queue, active turns, previews, menus, and lifecycle hooks, but route allowlisted, target-scoped Telegram API calls through the leader. When a follower promotes after heartbeat loss, status/state diagnostics expose only the transient `electing` lifecycle phase; stable `leader`/`follower` identity stays in the bus role so diagnostics do not duplicate role state. The TUI status bar and `/telegram-status` report `leader` or `follower` role so a registered follower is not shown as generically disconnected. Terminal status identity and the `[telegram|thread:name]` prompt label use the same target-aware current-instance resolver: registered local metadata wins over a stale shared binding for the matching target, while the binding remains a fallback for partial metadata.

Follower binding is manual and process-first: the operator starts another Pi process, then runs `/telegram-connect`; only then does that process register as a follower with an instance-scoped internal binding identity and cause the leader to create/reuse a thread for it. Telegram does not expose `/thread`, auto-spawn arbitrary unbound threads, or launch hidden follower subprocesses. In Threaded Mode, `/telegram-connect` does not offer manual takeover while a live leader exists; takeover is reserved for stale-leader election/recovery. Leadership remains an ephemeral transport role that another live follower can take over after stale heartbeat detection.

### Unbound Thread Detection

When Threaded Mode is enabled, writing a message in the `All` tab can create a new thread without an existing instance binding. The bridge detects this during update execution: if a message from the owner has a `message_thread_id` that no instance owns, the message is routed to the unbound-thread handler instead of the leader's normal message handler. In the default runtime, this handler first reclaims the thread for the leader when the leader has no active bound thread, assigns the current leader thread identity, persists the active binding, and serves the prompt locally. If the leader already has an active thread, the handler preserves the prompt in the source Telegram thread and shows a target-thread chooser; explicit successful routing may later close/delete only extra confirmed source threads through `thread-reconciler` proof-before-delete planning and stale-epoch fencing. Unknown `forum_topic_created` service events are recorded as observations and are not destructive cleanup proof, because Telegram can deliver creation events before local provisioning/binding writes become visible across reloads. If Threaded Mode is unavailable, the message is processed normally through classic routing.

Threadless messages from `All` are not routed as prompts once bound threads exist, because `All` cannot identify the owning Pi instance. Known commands open a compact live-target chooser, while ordinary prompts get guidance to use a bound Pi thread. This prevents accidental empty tabs from black-holing prompts or bypassing the manual follower-registration contract above.

The routing identity split is deliberate:

- Live routing owner: `instanceId` from the currently registered follower/leader runtime. A live instance may have only one active bound thread; provisioning a new target removes older current-state bindings for the same `instanceId` and closes duplicate Telegram threads when possible.
- Current binding owner: explicit `owner` metadata (`leader`, `manual-follower`, or API-level pending thread creation) plus cwd/thread-name metadata; string compatibility keys are derived internally and must not be the persisted source of ownership truth.
- Instance slot: extension-owned single-letter `A`-`Z` ordering metadata. New instances advance through the alphabet and wrap after `Z` only to a free slot; live concurrent instances are capped to available alphabet slots rather than duplicating occupied letters. The compact `bot.lastSlot` cursor persists while its binding remains live/recovering, including true `Z → A` wraparound. When post-grace follower compaction removes the binding represented by the cursor, the same reconciliation pass realigns it to the newest-created remaining live binding so removed historical followers cannot dictate fresh allocation; unexpired pending provisions and reservations remain collision guards. Other thread deletion paths may intentionally preserve an orphaned cursor to continue ring sequence.
- Instance thread name: durable human-facing identity metadata that replaces slot-only thread titles. Fresh threads choose one baked 4-6 letter Latin-word name from the assigned slot's curated palette using provisioning timestamp entropy and create the Telegram thread with that title immediately. Telegram-originated prompt prefixes expose this thread identity label, never follower/leader roles or generic seeds. Bare slot letters are fallback/legacy labels only; agents are not asked to name or rename threads.
- Telegram destination: `TelegramTarget` as `{ chatId, threadId? }`, where `threadId` is Telegram `message_thread_id` for UI thread targets.

Guest-mode updates are owned by the current transport leader by default in Threaded Mode. Guest queries have no Telegram thread binding and no local follower identity, so the leader queues and answers them unless a future explicit guest-owner policy is added. Followers may still transport `answerGuestQuery` through the leader for replies to work if a guest turn is ever delegated deliberately, but implicit guest routing does not pick an arbitrary follower.

All inbound updates are gated by the configured authorized user id.

## Core Flows

### Inbound Turn Flow

1. Poll updates through `getUpdates`.
2. Persist update offsets only after successful handling; repeated handler failures are bounded.
3. Filter to the paired private user; guest-mode updates require an existing paired user and cannot establish first pairing.
4. Dispatch owned callbacks and controls before fallback prompt forwarding.
5. Coalesce media groups, likely split long text, and one adjacent forward-plus-comment pair in either order when needed.
6. Download files into `~/.pi/agent/tmp/telegram` with size limits and partial-download cleanup.
7. Run configured/programmatic inbound handlers in order, appending successful stdout under `[outputs]`.
8. Add local attachments under `[attachments]`, optional voice context, and optional final `[time]` context.
9. Build a `PendingTelegramTurn` and append it to the bridge queue.
10. Handle `edited_message` updates separately while the original turn is still queued.
11. Dispatch only when all safety gates are clear.

Long-text split recovery remains conservative: only human text at or above the near-limit threshold opens its debounce window. Forward annotation has two semantic layers: the forward owns its source text/caption/media, while an optional separate owner-authored annotation normally precedes it. A bounded one-second pairing window joins that annotation and adjacent forward in either transport order, including a media-only forward without source caption text; the matching opposite-kind message flushes immediately. Same-kind rapid messages, commands, bots, ordinary non-forward captions, media groups, different senders/targets, reversed ids, and distant message ids do not enter this pairing path. Prompt construction always places the owner annotation first, followed by `[forward|from:...]` with the forward's own source text/caption, then source-attributed forwarded attachments, regardless of arrival order.

### Queue And Dispatch Safety

The bridge keeps its own Telegram queue. Queue items have two explicit dimensions:

- `kind`: `prompt` or `control`.
- `queueLane`: `control`, `priority`, or `default`.

Dispatch rank:

1. `control` lane.
2. `priority` prompt lane.
3. `default` prompt lane.

Admission and planning validate lane contracts. Invalid lane/kind pairings fail predictably instead of being silently coerced.

Dispatch requires:

- No active Telegram turn.
- No pending Telegram dispatch already sent to Pi.
- No compaction in progress.
- `ctx.isIdle()` is true.
- `ctx.hasPendingMessages()` is false.

A dispatched prompt remains queued until `agent_start` consumes it. This keeps the active Telegram turn bound for previews, attachments, aborts, and final replies. A low-level `agent_end` error also retains that active turn because Pi may retry automatically; a later successful `agent_end` delivers through the original target and metadata, while `agent_settled` proves that an unrecovered error can be finalized once before queue dispatch resumes.

Post-agent-end queue dispatch uses a session-bound deferred dispatcher. It is activated on session start, clears timers on shutdown, and skips callbacks from older generations before touching `ExtensionContext`. Dispatch stays session-bound after polling ownership moves elsewhere. When a queued Telegram prompt is forwarded into Pi, it uses a normal `sendUserMessage(content)` turn after the bridge's idle/dispatch guards pass; it does not use Pi's `followUp` delivery option or inject terminal input.

One monotonic session generation also fences agent/tool/message events, compaction callbacks, preview state, scheduled final delivery, controls, and shutdown. Distinct Pi context objects observed within one session adopt that generation; contexts already observed under an older generation remain stale after replacement. Session start invalidates pending preview work, delayed finals check their captured context before delivery, and shutdown rechecks after asynchronous polling/preview boundaries with a bounded preview-clear wait.

For a configured Rich response with final text and exactly one supported queued PNG/JPEG, MP4, or MP3 artifact, queue orchestration asks `outbound-attachments` for one reply-anchored multipart Rich result before finalizing ordinary text. A successful result clears the preview, records exact message ownership, and suppresses duplicate text/file delivery. A known-safe rejection returns to the established paths; an ambiguous send stops the turn without fallback or replay. HTML mode, multiple or unsupported files, Guest Mode, and all voice-policy outputs bypass this optimization.

### Controls And Menus

Telegram controls execute through command/callback domains, not by entering the normal prompt queue unless they intentionally create a prompt turn.

Immediate controls:

- `/start` opens the main inline application menu.
- `/model`, `/thinking`, `/queue`, and `/settings` are hidden shortcuts to menu sections.
- `/compact` opens an inline confirmation dialog and then runs compaction when the bridge is idle.
- `/next` dispatches the next queued turn, aborting Pi first when needed.
- `/abort` aborts active work while preserving queued items. Abort-history preservation is enabled only for Telegram-owned active turns; later local/non-Telegram agent starts clear stale abort-history mode so the next Telegram prompt appends instead of absorbing old queued turns as history.
- `/stop` aborts and clears waiting Telegram queue items.

Queued controls:

- `/continue` creates a priority Telegram-owned `continue` prompt.
- Prompt-template commands expand Telegram-safe Pi template aliases before entering the prompt queue.
- Model-switch continuation uses the control lane when an in-flight Telegram-owned run must be stopped and resumed.

Queue and menu mutations are reachable through Telegram updates handled by the current polling owner. After ownership moves, the old instance keeps processing its accepted local queue, but it no longer receives new menu callbacks or control updates for remote mutation. UI label, navigation, tab, toggle, card, and dialog rules are defined in [UI Style](./ui-style.md). Callback prefix ownership is defined in [Callback Namespaces](./callback-namespaces.md).

### Compaction And Typing Status

Manual `/compact` requires inline confirmation because accidental taps are disruptive. Confirmed manual compaction and auto-compaction both set the bridge compaction flag, block queued prompt dispatch, retain that flag in explicit diagnostics, and clear it on compact completion, timeout fallback, or session shutdown. Pi owns its terminal compaction lifecycle; pi-telegram keeps `Active` scoped to Telegram-owned work and otherwise preserves the stable connected/leader/follower role.

Native typing during compaction follows connected-instance activity rather than terminal status:

- Confirmed manual `/compact` starts a native `typing` keepalive in the command target and stops it on completion/failure.
- Automatic/session compaction with an active Telegram turn reuses that turn's target.
- Automatic/session compaction without an active Telegram turn uses the connected instance's assigned target; an unconnected instance sends nothing.
- Thread-targeted typing is sent to the concrete thread and mirrored to `All` as the aggregate activity surface; completion, timeout, and shutdown stop the keyed loop.

At every connected instance `agent_start`, the lifecycle binding starts Telegram's native `…typing` indicator in that instance's assigned target, whether the run came from Telegram, the local TUI, or an autonomous continuation such as Grow Loop. Terminal `Active` remains Telegram-turn-specific; the native indicator answers the separate question of whether the instance is doing agent work. Each loop keeps one action in flight, while the leader API runtime coalesces identical chat/thread/action calls across local and follower traffic for two seconds. A Telegram 429 response opens the exact action's shared `retry_after` suppression window without scheduling delayed retries or projecting expected activity throttling as a terminal status error. Assistant message start/update hooks still re-arm it during Telegram-owned turns so transient provider/model errors do not leave a continuing run without activity feedback, and agent/session completion stops it.

### Rendering And Delivery

Rich Markdown is the default model-answer membrane. Complete assistant replies send final Markdown directly as `InputRichMessage.markdown` through `sendRichMessage` when `assistant.rendering` is `rich`, and through the legacy Markdown-to-HTML renderer when `assistant.rendering` is `html`; guest replies use native Rich Markdown through `InputRichMessageContent` in `answerGuestQuery` results. Tool-call rows, reasoning/thinking blocks, menus, status rows, queue controls, settings, diagnostics, and other harness-owned surfaces stay on explicit Telegram HTML/plain rendering. Streaming previews may use `sendRichMessageDraft` only when `assistant.draftPreviews` is enabled and draft delivery succeeds. The bridge still strips top-level assistant action comments before delivery and may split output only for Telegram transport limits.

Assistant delivery guarantees:

- Model-authored Markdown is the source of truth; the bridge does not pre-render assistant Markdown to HTML unless the operator selects `assistant.rendering: "html"` for compatibility.
- Before native Rich Markdown delivery, the bridge normalizes known Bot-API-fragile source forms without changing visible meaning, including space-after-marker blockquotes and dollar-prefixed ticker atoms that Telegram may otherwise treat as unterminated math.
- Prompt context blocks use compact metadata (`[tag|key:value]`) as the stable inbound contract. `[telegram...]` names the current surface only: owner/current turns use `[telegram]` or `[telegram|thread:<name>]`; guest-mode turns use `[telegram|guest:<group-title-or-peer-username-or-id>]`. In a private Guest Mode turn the paired owner's `from` identity is never the guest: the remote private-chat identity wins, then non-owner caller metadata, with a non-bot replied peer available only as a final identity fallback when stronger conversation evidence is absent; username falls back to the remote display name and numeric id. Reply attribution still belongs independently in `[reply|from:...]`, and a replied bot can never define or replace the current `[telegram|guest:...]` location identity. Source authors for quoted/forwarded material and their files are carried by `[reply|from:<username-or-id>]`, `[forward|from:<username-or-id>]`, and `[attachments|from:<username-or-id>]`, while plain `[attachments]` remains current-turn attachments and is ordered before reply/forward/source context. Media embedded in inbound Telegram `rich_message` blocks is downloaded like ordinary message media and stays attached to its forward-source block instead of being mislabeled as current-user material.
- Quoted rich replies use Telegram `rich_message` blocks as the prompt-context source when available, so `[reply]` context receives rendered plain text instead of raw `InputRichMessage.markdown` fallback text.
- Long native Markdown replies are split only at Telegram Rich Message transport limits; oversized fenced code, display-math, and fully wrapped inline-formatting blocks are rewrapped per chunk so persisted Rich Markdown chunks remain structurally valid.
- When Draft previews are enabled, streaming previews pass structurally closed assistant Markdown prefixes through to `sendRichMessageDraft` with ownership checks, voice suppression, and serialized flushes. Unclosed inline spans, links, fenced code, comments, and display-math blocks are held back until a safe boundary exists. Draft failures are recorded and the failing frame is skipped instead of degrading to raw plain-message previews, because partial Markdown can be invalid while the final message remains valid.
- Preview flushes are serialized so older edits cannot race newer drafts; final delivery waits for active draft flushes and does not perform a post-final draft-clear call.

UI/compat rendering guarantees:

- Bridge-owned UI surfaces such as tool rows, reasoning/thinking blocks, commands, menus, status messages, queue controls, diagnostics, settings, and interactive sections use Telegram HTML/plain rendering helpers by default. These texts are authored for operational UI rather than model output, so explicit HTML/plain markup remains clearer, safer, and easier to maintain.
- In those UI/compat surfaces, real code blocks stay literal and escaped, supported absolute links stay clickable, unsupported links degrade safely, tables use compact monospace rendering with grapheme/display-width accounting, and list/quote/heading spacing stays Telegram-safe.

Final delivery attaches reply metadata only where requested. Reply parameters apply only to the first chunk of split messages; continuation chunks are adjacent normal messages. Media-group turns reply to the representative message id.

### Outbound Artifacts And Assistant Actions

Outbound files staged during an active Telegram turn are delivered after that turn completes. They use `telegram_attach`, are checked atomically per tool call, and use configurable size limits before photo/document upload. When no Telegram turn is active, `telegram_attach` sends files immediately to the paired/default chat, an assigned follower thread, or an explicit `chat_id` plus optional `thread_id`; `telegram_message` provides direct local/TUI Markdown text delivery for explicit user requests and runs the same `telegram_button` markup planner so buttons attach to that text message. Direct local/TUI delivery is singleton-controlled: classic mode requires this Pi instance to own `/telegram-connect`, while Threaded Mode followers must be registered and route through the leader-owned transport. Already accepted active-turn reply/attachment delivery remains session-local.

Assistant-authored final-message actions use hidden top-level comments:

- `telegram_voice` creates voice reply artifacts through configured outbound handlers, programmatic voice handlers, or registered synthesis providers.
- `telegram_button` creates inline buttons whose callbacks enqueue the configured prompt text as a normal Telegram prompt turn.

Preview delivery strips top-level action comments before streaming draft Markdown. Comments inside code fences, quotes, lists, or indented examples stay literal.

Unknown callback data outside owned prefixes is forwarded as `[callback] <data>` only after built-in and extension handlers decline it.

## Extension Surfaces

`pi-telegram` intentionally owns one `getUpdates` loop per bot. `polling` owns that internal loop; `updates` owns classification/default-routing plans plus the public handler registry layered extensions use to observe or consume updates without opening a competing polling connection. Layered extensions should integrate through extension surfaces instead of polling the same bot independently.

- Raw update observation/consumption: [Updates](./updates.md).
- Telegram-native slash commands: `registerTelegramCommand()` from [Public API](./public-api.md#commands).
- Target-aware operational views and chat actions: [Telegram Delivery API](./delivery.md).
- Normalized non-blocking Pi lifecycle events: [Telegram Activity API](./activity.md); the separate [`pi-telegram-extension-demo`](https://github.com/llblab/pi-telegram-extension-demo) project remains the companion-extension reference.
- Structured inline UI sections: [Sections](./sections.md).
- Callback namespace discipline: [Callback Namespaces](./callback-namespaces.md).
- Voice/STT/TTS providers: [Voice Integration](./voice.md).
- Inbound/outbound command-template handlers: [Command Templates](./command-templates.md).

Extension callbacks must avoid `pi-telegram` owned prefixes such as `compact:`, `tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `settings:`, and `section:`. Workflow-specific Telegram slash commands should use the public command registry instead of becoming new core built-ins unless they are bridge lifecycle, transport ownership, queue safety, or essential operator controls.

The bridge does not mirror arbitrary `ctx.ui.confirm/input/select/custom` prompts from other extensions into Telegram. Companion extensions that need Telegram operation should expose a Telegram-native command, section, settings row, callback, status line, inbound/update handler, or assistant action-markup path instead of relying on hidden TUI-only prompts.

## Diagnostics And Operational Behavior

Status rendering distinguishes connected, active, dispatching, queued, tool-running, model-switching, and compacting states. If a queue mutation removes the last waiting item while Telegram-owned work still has running tools, status remains active instead of degrading to connected.

Queue reactions are shortcut controls for waiting turns. Promotion reactions (`👍`, `⚡️`, `❤️`, `🕊`, `🔥`) move prompts to priority; removal reactions (`👎`, `👻`, `💔`, `💩`, `🗑`) remove waiting turns because ordinary Telegram DM deletions are not exposed through Bot API polling.

`/telegram-status` records grouped diagnostics for transport/API, polling/update, prompt dispatch, controls, typing, compaction, setup, session lifecycle, attachment queue/delivery, and recent redacted runtime events. Expected preview noise such as unchanged edit responses is filtered out. The compact TUI status renders only `error`; detailed failure text remains in diagnostics and profile-scoped logs instead of expanding the status line.

When `assistant.proactivePush` is enabled and this instance has exact direct or follower transport authority, completed public assistant text blocks from local/autonomous work are sent once and in source order to the instance's authorized target. Visible commentary/checkpoints and the final block use the configured Rich or HTML renderer. Hidden reasoning, tool traffic, token deltas, local prompt text, Telegram-owned turns, and stale generations are not mirrored. Each admitted block remains fenced to its exact target, profile/token stamp, leader epoch or follower registration generation, and session generation; non-idempotent acknowledgement ambiguity never authorizes replay.

Telegram prompt guidance is context-aware. Unconfigured sessions receive no bridge suffix. Local/TUI prompts receive only explicit direct-delivery guidance. Telegram-originated turns receive a compact pointer to `telegram_help` plus dynamic prompt blocks such as `[voice] delivery: automatic voice`; full voice/button/direct-delivery/Threaded Mode syntax stays in the help tool rather than every system prompt.

## In-Flight Model Switching

When `/model` is used during an active Telegram-owned run, the bridge can emulate Pi's interactive stop/switch/continue workflow:

1. Apply the selected model immediately.
2. Queue or stage a synthetic Telegram continuation turn.
3. Abort the active Telegram turn immediately, or wait for the current tool to finish before aborting.
4. Dispatch the continuation after abort completion.

This is limited to Telegram-owned runs. If Pi is busy with non-Telegram work, the bridge refuses the switch instead of hijacking unrelated activity.

## Shutdown And Timer Lifecycle

`session_shutdown` is the hard boundary for session-bound runtime work. It suspends Telegram polling through the locked polling runtime, aborts the poll controller, stops native typing, unbinds deferred queue dispatch, suspends pending media/text-group debounce work for rebinding to the replacement session, clears preview state, clears active turns, and drops the active abort handler.

Non-critical timers are `unref()`ed so print/headless processes are not kept alive only by Telegram housekeeping. This includes typing keepalive intervals, bounded typing-idle waits, deferred queue dispatch, media/text-group debounce windows, preview flush timers, and polling retry sleeps. Polling retry sleep is abort-aware, so shutdown does not wait for the normal retry delay after a polling error.

Non-interactive `pi -p` runs must remain passive unless Pi provides a live Telegram session lifecycle. Loading the extension with `telegram.json`, proactive push settings, or existing lock state must not by itself keep the print-mode process alive or let a non-owner send proactive Telegram output.

## Related

- [README.md](../README.md)
- [Project Context](../AGENTS.md)
- [Project Backlog](../BACKLOG.md)
- [Changelog](../CHANGELOG.md)
