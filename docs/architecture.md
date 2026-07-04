# Telegram Bridge Architecture

## Purpose

`pi-telegram` is a session-local Pi extension that binds one Telegram DM to one running Pi session. It owns the Telegram bridge boundary:

- Poll Telegram updates and enforce single-user pairing.
- Translate Telegram text, callbacks, media, and files into Pi turns.
- Stream previews and deliver final Pi responses back to Telegram.
- Provide Telegram-native controls for queueing, model/thinking/settings menus, compaction, abort/stop, prompt templates, reactions, and outbound artifacts.

The bridge is a mobile companion for a live Pi session, not a remote terminal. It should let an operator start work in the TUI and continue supervising from Telegram, while staying inside Pi's extension-facing contracts.

This document is the architectural map. Focused behavior standards live in sibling docs:

- [Public API](./public-api.md) — stable commands, config, package entrypoints, assistant markup, extension APIs, and compatibility boundaries.
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

`pi-telegram` runs inside the current Pi process as an extension. That gives it safe access to public extension APIs such as aborting work, compacting, sending follow-up prompts, observing lifecycle events, and rendering Telegram-native controls. It does not own the terminal, the interactive-mode chat transcript, or the process lifecycle.

Keep this boundary explicit:

- Do not use raw TTY injection, ANSI terminal clearing, private TUI container mutation, or a shadow `pi` subprocess to simulate interactive commands.
- Do not treat Telegram as a generic remote shell for every Pi slash command.
- Commands that require interactive session replacement or TUI rerendering, such as a true Telegram `/new`, need a public Pi API that invokes the same runtime path as the terminal command.
- A separate PTY supervisor or daemon could choose to own those risks, but that would be a different product mode rather than this extension's runtime contract.

The repository uses a **Flat Domain DAG**:

- Local imports must form a directed acyclic graph.
- Cohesive domain files are preferred over atomizing every helper.
- Shared buckets such as `lib/constants.ts` or `lib/types.ts` are avoided.
- Constants and state types live with their owning domain.
- Narrow structural projections are allowed when they avoid importing broader runtime or wire DTOs.
- Source file headers include `Zones:` tags so cross-cutting responsibility stays visible without folder nesting.

### Domain Ownership Map

- `index.ts`: composition root for live ports, session state, transport adapters, and lifecycle registration.
- `api`: Bot API helpers, retries, uploads/downloads, temp cleanup, byte limits, chat actions, lazy token clients, and API error recording.
- `config` / `setup`: `telegram.json`, bot token setup, first-user pairing, authorization, env fallback, atomic persistence, and live config accessors.
- `locks` / `polling`: singleton lock storage and status labels, lock-aware polling lifecycle/takeover/follower-registration orchestration, classic-vs-Threaded polling switching, Threaded Mode capability probes/monitoring, long-poll controller state, offset persistence, and poll-loop wiring.
- `bus` / `bus-api` / `bus-leader` / `bus-follower` / `ownership` / `target`: Threaded Mode multi-instance bus contracts, local leader/follower IPC, leader-only orchestration, follower-side manual registration/session runtime, follower-routed Bot API calls, live message ownership, and `{ chatId, threadId? }` target identity. `bus` owns shared protocol and local IPC primitives; `bus-leader` owns leader runtime, leader envelope handling, activation scheduling, and leader polling/server/prune orchestration; `bus-follower` owns this Pi instance's follower-side registration, heartbeat, forwarded-update receiver, and routed API caller without any process spawning.
- `sync`: demand-driven Telegram reconciliation and local assumption policy. It does not own a complete Telegram bot read-model; Bot API lacks a complete topic/thread listing surface. It owns sync slices, invalidation triggers, observation intake, status/debug freshness, and reconciliation scheduling across bot identity, pairing assumptions, live target bindings, reservations, and transport health after meaningful observable signals. It should call narrower domain primitives rather than letting `index.ts`, `threads`, or `status` accumulate cross-cutting reconciliation policy.
- `thread-reconciler`: Threaded Mode control-plane planning for Telegram thread/tab lifecycle. It owns the reconciliation state machine (`stable`, `provisioning`, `sync-required`, `cleanup-required`), pure plans, proof-before-delete rules, pending-provision protection, fresh-creation grace windows, leader-epoch checks, and the single policy authority for destructive thread cleanup actions. It excludes live Telegram API calls, inbound routing, menu rendering, and direct persistence.
- `threads`: Telegram UI thread/tab binding state mapped to Bot API `message_thread_id` / `ForumTopic` transport. Owns current thread target state, slot allocation from the current extension state, baked compact thread-name selection, current binding persistence, and primitive thread provision helpers. It should not persist stale/offline/failed target history, own destructive cleanup policy, grow into the general Telegram synchronization domain, or expose a rename tool.
- `updates` / `routing`: update classification, authorization planning, callbacks, edited messages, reactions, target-owner forwarding, and inbound route composition.
- `media` / `text-groups` / `time-injection` / `turns` / `inbound`: inbound text/media/file extraction, rich-message reply-context plaintext recovery, media-group debounce, long-text coalescing, optional `[time]` context, handler execution, and prompt-turn assembly/editing.
- `queue`: queue item contracts, lane admission/order, readiness gates, mutations, dispatch runtime, prompt/control enqueueing, and session/agent/tool lifecycle sequencing.
- `runtime`: session-local coordination primitives: counters, flags, setup guard, abort handler, typing timers, dispatch flags, and reset binding.
- `model` / `menu-model` / `menu-thinking` / `menu-status` / `menu-queue` / `menu-settings` / `menu` / `commands`: model identity, thinking levels, scoped model handling, menu render/callback behavior, slash commands, bot commands, and interactive controls.
- `sections`: Telegram menu-section registry, opaque section callback tokens, render/callback dispatch, safe section ports, and diagnostics.
- `keyboard`: shared inline-keyboard reply-markup shape only; feature domains own labels, callback data, and behavior.
- `preview` / `replies` / `rendering`: throttled native Rich Markdown draft delivery, native final reply delivery, reply parameters, transport-limit chunking, and remaining Telegram HTML rendering for bridge-owned UI/compatibility surfaces.
- `outbound-markup`: top-level assistant action comment parsing, attribute parsing, voice reply planning, and preview/delivery stripping.
- `outbound`: outbound text transformations, voice/button artifact delivery, and generated callback actions.
- `outbound-attachments`: `telegram_attach`, queued outbound files, stat/limit checks, and photo/document delivery classification.
- `status`: status bar/status-message rendering, queue-lane summaries, redacted event ring, and grouped diagnostics.
- `lifecycle` / `prompts` / `prompt-templates` / `pi`: Pi hook registration, Telegram prompt guidance, prompt-template discovery/expansion, and centralized direct Pi SDK imports.
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

Telegram configuration lives in `~/.pi/agent/telegram.json`. Polling ownership lives separately in `~/.pi/agent/locks.json` under `@llblab/pi-telegram`.

### Setup Flow

`/telegram-setup` progressively resolves the bot token:

1. Use the locally saved token when present.
2. Otherwise use the first supported Telegram token environment variable.
3. Otherwise show the example placeholder.

`ctx.ui.input()` only supports placeholder text, so setup uses `ctx.ui.editor()` when a real default must appear already filled in. Persisted config is written through a private temp file plus atomic rename and left with `0600` permissions.

### Runtime Ownership

- `/telegram-connect` acquires or moves singleton polling ownership before polling starts.
- `/telegram-disconnect` stops polling and releases ownership. In Threaded Mode it first tears down the disconnecting instance's bound Telegram thread: leaders delete their own thread directly, and followers ask the leader to delete their assigned thread through scoped bus API before unregistering.
- Session start schedules Telegram polling resume asynchronously only when the existing lock already points at the current `pid`/`cwd`, or when a stale same-`cwd` lock can be safely replaced after process restart. Startup and `/resume` should not wait on Telegram leader election, Bot API probes, poller handoff, or thread reconciliation before restoring the Pi session.
- Pi `print`/`json` run modes stay passive: they do not start or resume Telegram polling even if a lock is present. Older Pi runtimes without `ctx.mode` keep the previous compatibility behavior.
- Inherited child sessions that see the same `telegram.json` but do not own the `pid`/`cwd` lock must not auto-start polling or call `getUpdates` unless the operator force-takes ownership.
- Session replacement suspends polling/watchers without releasing ownership so the next session-start hook in the same process can resume.
- Live polling owners require explicit takeover confirmation.
- Long-lived polling timers use snapshotted ownership context and stop local polling when the lock no longer points at their own process.
- `locks.json` owns only external Telegram control/polling. Local extension and queue state are per Pi instance: losing the lock stops live Telegram control here, but does not drain or silence this instance's accepted queue, previews, final delivery, or dispatch.
- Proactive local/headless final-result push is not accepted-turn delivery. It is allowed only when proactive push is enabled and this instance currently owns the Telegram lock.

Deleting `locks.json` resets runtime ownership without deleting Telegram configuration.

### Threaded Mode Multi-Instance Bus

Telegram private-chat Threaded Mode is the public switch for multi-instance Telegram operation. Classic single-DM polling is the base mode. When Telegram private-chat threads are available for the bot, the bridge enables the local leader/follower bus automatically; when threads are unavailable or later disabled, the bridge returns to classic single-DM polling as a first-class mode.

When Threaded Mode is active, the current polling owner is also the Telegram bus leader. The leader owns the local bus endpoint (Unix-domain socket on Unix-like platforms, named pipe on native Windows), polls `getUpdates`, performs direct Bot API calls, records follower heartbeats, prunes stale followers, and provisions Telegram UI thread targets through live runtime/bus state. Follower liveness is intentionally fast because heartbeat traffic is local IPC: followers heartbeat every `1s`, the leader treats them as stale after `2s`, and the prune loop runs every `1s` so stopped followers are detected promptly while active forwarded updates/API calls still refresh liveness. Heartbeat pruning is silent liveness bookkeeping: it preserves the follower thread binding and does not send a Telegram-visible disconnected notice, because the common cause may be leader reload or IPC handoff rather than a dead follower. `tmp/telegram/logs.jsonl` is a session-local redacted runtime evidence stream for race debugging; it resets on extension start and runtime scope changes, and must not become routing/provisioning authority. `tmp/telegram/state.json` is an extension+bot observable/debug snapshot aligned with status diagnostics: `source: "snapshot"` and `writtenAtMs` mark it as observational, not authoritative. Fresh capability observations may skip redundant startup probes, but stale snapshots re-probe before suppressing bus/thread behavior. Top-level `bot` mirrors bot-wide capabilities such as thread mode, `runtime` describes process role/status, `liveRoster` mirrors followers/current targets/reservations, `diagnostics` mirrors recent status/debug signals including the latest thread-reconciler phase/counts, `threads` stores current routeable bindings, TTL-bounded reservations explain short-lived slot collision guards, and TTL-pruned `pendingProvisions` protects in-flight topic creation slots from cleanup/allocation races. Fresh provisioning writes pending state before the Bot API create call, adds the returned target to the pending record, persists a `starting` binding, then promotes it to `active` and clears pending state. If final binding persistence fails after Telegram returns a thread id, the targeted pending provision remains as cleanup/retry evidence. Once targeted pending provisions expire, they are retained for `thread-reconciler` close/delete cleanup and pending scratchpad removal after a successful cleanup apply; untargeted expired pending records can prune without cleanup because no Telegram thread id exists. Runtime events coalesce status-snapshot writes so transient bus/API/update failures remain inspectable even when the operator has not opened `/telegram-status`. The bridge must not keep a durable `telegram-targets.json` target history; stale/offline/failed thread observations are pruned instead of reused. Previous-process leader bindings that still probe alive become reservations/collision guards, not routeable active threads, so a reloaded leader can take the next free slot without duplicating the same visible tab name. The thread chat is always the private bot DM with the paired owner (`allowedUserId`). In Telegram private-chat Threaded Mode, the leader creates/reuses its own thread before polling — it is a real bound instance, not a dispatcher. Followers authenticate bus envelopes with the leader-minted capability secret stored in the active lock entry. Leader lock entries also carry a stable `leaderEpoch` minted on acquisition and preserved across heartbeat refreshes; leader-owned cleanup/provisioning plans stamp that epoch, and Thread Reconciler apply skips destructive work if leadership has moved on before side effects run. Followers own their own Pi session state, queue, active turns, previews, menus, and lifecycle hooks, but route allowlisted, target-scoped Telegram API calls through the leader. When a follower promotes after heartbeat loss, status/state diagnostics expose only the transient `electing` lifecycle phase; stable `leader`/`follower` identity stays in the bus role so diagnostics do not duplicate role state. The TUI status bar and `/telegram-status` report `leader` or `follower` role so a registered follower is not shown as generically disconnected.

Follower binding is manual and process-first: the operator starts another Pi process, then runs `/telegram-connect`; only then does that process register as a follower with an instance-scoped internal binding identity and cause the leader to create/reuse a thread for it. Telegram does not expose `/thread`, auto-spawn arbitrary unbound threads, or launch hidden follower subprocesses. In Threaded Mode, `/telegram-connect` does not offer manual takeover while a live leader exists; takeover is reserved for stale-leader election/recovery. Leadership remains an ephemeral transport role that another live follower can take over after stale heartbeat detection.

### Unbound Thread Detection

When Threaded Mode is enabled, writing a message in the `All` tab can create a new thread without an existing instance binding. The bridge detects this during update execution: if a message from the owner has a `message_thread_id` that no instance owns, the message is routed to the unbound-thread handler instead of the leader's normal message handler. In the default runtime, this handler first reclaims the thread for the leader when the leader has no active bound thread, assigns the current leader thread identity, persists the active binding, and serves the prompt locally. If the leader already has an active thread, the handler preserves the prompt in the source Telegram thread and shows a target-thread chooser; explicit successful routing may later close/delete only extra confirmed source threads through `thread-reconciler` proof-before-delete planning and stale-epoch fencing. Unknown `forum_topic_created` service events are recorded as observations and are not destructive cleanup proof, because Telegram can deliver creation events before local provisioning/binding writes become visible across reloads. If Threaded Mode is unavailable, the message is processed normally through classic routing.

Threadless messages from `All` are not routed as prompts once bound threads exist, because `All` cannot identify the owning Pi instance. Known commands from `All` open a compact live-target chooser, while ordinary threadless prompts get guidance to use a bound Pi thread tab. This preserves a safe default after the operator closes every thread while still preventing later accidental empty tabs from black-holing prompts or spawning hidden Pi processes. The operator-facing path for another instance is visible manual follower registration: start Pi in a terminal, then run `/telegram-connect`.

The routing identity split is deliberate:

- Live routing owner: `instanceId` from the currently registered follower/leader runtime. A live instance may have only one active bound thread; provisioning a new target removes older current-state bindings for the same `instanceId` and closes duplicate Telegram threads when possible.
- Current binding owner: explicit `owner` metadata (`leader`, `manual-follower`, or API-level pending thread creation) plus cwd/thread-name metadata; string compatibility keys are derived internally and must not be the persisted source of ownership truth.
- Instance slot: extension-owned single-letter `A`-`Z` ordering metadata. New instances advance monotonically through the alphabet and wrap after `Z` only to a free slot; closed lower slots are not backfilled out of order, and live concurrent instances are capped to available alphabet slots rather than duplicating occupied letters. The compact `bot.lastSlot` cursor is durable across reloads/live-test history, so after it reaches `Z` a later new thread may intentionally become `A` again if `A` is currently free.
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
5. Coalesce media groups and likely split long text when needed.
6. Download files into `~/.pi/agent/tmp/telegram` with size limits and partial-download cleanup.
7. Run configured/programmatic inbound handlers in order, appending successful stdout under `[outputs]`.
8. Add local attachments under `[attachments]`, optional voice context, and optional final `[time]` context.
9. Build a `PendingTelegramTurn` and append it to the bridge queue.
10. Handle `edited_message` updates separately while the original turn is still queued.
11. Dispatch only when all safety gates are clear.

Long-text split recovery is intentionally conservative: only human text at or above the near-limit threshold opens the debounce window; commands, bots, captions, media groups, and normal short follow-ups bypass it.

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

A dispatched prompt remains queued until `agent_start` consumes it. This keeps the active Telegram turn bound for previews, attachments, aborts, and final replies.

Post-agent-end queue dispatch uses a session-bound deferred dispatcher. It is activated on session start, clears timers on shutdown, and skips callbacks from older generations before touching `ExtensionContext`. Dispatch stays session-bound after polling ownership moves elsewhere. When a queued Telegram prompt is forwarded into Pi, it uses Pi's explicit `followUp` delivery option so Telegram input preserves the existing non-steering queue contract even if Pi is still settling active work.

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

Manual `/compact` requires inline confirmation because accidental taps are disruptive. Confirmed manual compaction and auto-compaction both set the bridge compaction flag, block queued prompt dispatch, update status to `compacting`, and clear that state on compact completion, timeout fallback, or session shutdown.

Native typing during compaction is deliberately narrower than the compaction flag:

- Confirmed manual `/compact` always starts a native `typing` keepalive in the command target and stops it on completion/failure.
- Automatic/session compaction starts native `typing` only when there is an active Telegram-owned turn; it must reuse that active turn's target.
- Startup, reload, connect/reconnect, restore, leader/follower recovery, and idle/background compaction without an active Telegram turn must not send visible typing.
- Thread-targeted typing is sent to the concrete thread and mirrored to `All` as the aggregate activity surface.

During active Telegram-owned turns, assistant message start/update hooks re-arm typing so transient provider/model errors do not leave a continuing run without Telegram activity feedback.

### Rendering And Delivery

Rich Markdown is the default model-answer membrane. Complete assistant replies send final Markdown directly as `InputRichMessage.markdown` through `sendRichMessage` when `assistantRendering` is `rich`, and through the legacy Markdown-to-HTML renderer when `assistantRendering` is `html`; guest replies use native Rich Markdown through `InputRichMessageContent` in `answerGuestQuery` results. Tool-call rows, reasoning/thinking blocks, menus, status rows, queue controls, settings, diagnostics, and other harness-owned surfaces stay on explicit Telegram HTML/plain rendering. Streaming previews may use `sendRichMessageDraft` only when Draft previews are enabled and draft delivery succeeds. The bridge still strips top-level assistant action comments before delivery and may split output only for Telegram transport limits.

Assistant delivery guarantees:

- Model-authored Markdown is the source of truth; the bridge does not pre-render assistant Markdown to HTML unless the operator selects `assistantRendering: "html"` for compatibility.
- Before native Rich Markdown delivery, the bridge normalizes known Bot-API-fragile source forms without changing visible meaning, including space-after-marker blockquotes and dollar-prefixed ticker atoms that Telegram may otherwise treat as unterminated math.
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
- Structured inline UI sections: [Sections](./sections.md).
- Callback namespace discipline: [Callback Namespaces](./callback-namespaces.md).
- Voice/STT/TTS providers: [Voice Integration](./voice.md).
- Inbound/outbound command-template handlers: [Command Templates](./command-templates.md).

Extension callbacks must avoid `pi-telegram` owned prefixes such as `compact:`, `tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `settings:`, and `section:`. Workflow-specific Telegram slash commands should use the public command registry instead of becoming new core built-ins unless they are bridge lifecycle, transport ownership, queue safety, or essential operator controls.

The bridge does not mirror arbitrary `ctx.ui.confirm/input/select/custom` prompts from other extensions into Telegram. Companion extensions that need Telegram operation should expose a Telegram-native command, section, settings row, callback, status line, inbound/update handler, or assistant action-markup path instead of relying on hidden TUI-only prompts.

## Diagnostics And Operational Behavior

Status rendering distinguishes connected, active, dispatching, queued, tool-running, model-switching, and compacting states. If a queue mutation removes the last waiting item while Telegram-owned work still has running tools, status remains active instead of degrading to connected.

Queue reactions are shortcut controls for waiting turns. Promotion reactions (`👍`, `⚡️`, `❤️`, `🕊`, `🔥`) move prompts to priority; removal reactions (`👎`, `👻`, `💔`, `💩`, `🗑`) remove waiting turns because ordinary Telegram DM deletions are not exposed through Bot API polling.

`/telegram-status` records grouped diagnostics for transport/API, polling/update, prompt dispatch, controls, typing, compaction, setup, session lifecycle, attachment queue/delivery, and recent redacted runtime events. Expected preview noise such as unchanged edit responses is filtered out.

When proactive push is enabled and this instance owns the Telegram lock, successful local non-Telegram final replies are sent to the paired chat. Non-owners skip proactive delivery and record a runtime diagnostic. Local prompt text is not mirrored because the bot does not own terminal user messages.

Telegram prompt guidance is context-aware. Unconfigured sessions receive no bridge suffix. Local/TUI prompts receive only explicit direct-delivery guidance so ordinary terminal replies do not learn raw Telegram action-comment syntax. Telegram-originated turns receive the full inbound context, phone-width output, and native action contract, including the 37-display-cell mobile readability hint.

## In-Flight Model Switching

When `/model` is used during an active Telegram-owned run, the bridge can emulate Pi's interactive stop/switch/continue workflow:

1. Apply the selected model immediately.
2. Queue or stage a synthetic Telegram continuation turn.
3. Abort the active Telegram turn immediately, or wait for the current tool to finish before aborting.
4. Dispatch the continuation after abort completion.

This is limited to Telegram-owned runs. If Pi is busy with non-Telegram work, the bridge refuses the switch instead of hijacking unrelated activity.

## Shutdown And Timer Lifecycle

`session_shutdown` is the hard boundary for session-bound runtime work. It suspends Telegram polling through the locked polling runtime, aborts the poll controller, stops native typing, unbinds deferred queue dispatch, clears pending media/text-group input, clears preview state, clears active turns, and drops the active abort handler.

Non-critical timers are `unref()`ed so print/headless processes are not kept alive only by Telegram housekeeping. This includes typing keepalive intervals, bounded typing-idle waits, deferred queue dispatch, media/text-group debounce windows, preview flush timers, and polling retry sleeps. Polling retry sleep is abort-aware, so shutdown does not wait for the normal retry delay after a polling error.

Non-interactive `pi -p` runs must remain passive unless Pi provides a live Telegram session lifecycle. Loading the extension with `telegram.json`, proactive push settings, or existing lock state must not by itself keep the print-mode process alive or let a non-owner send proactive Telegram output.

## Related

- [README.md](../README.md)
- [Project Context](../AGENTS.md)
- [Project Backlog](../BACKLOG.md)
- [Changelog](../CHANGELOG.md)
