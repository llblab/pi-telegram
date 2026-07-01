# Telegram Multi-Instance Bus Architecture

## Status

Implemented for paired bots where Telegram exposes private-chat Threaded Mode. Classic/private-chat mode remains the default whenever Telegram threads are unavailable, and live Telegram client smoke remains the release gate for client-visible thread UX.

This document uses **thread** as the canonical product term because Telegram clients present the tabbed UI as threads. The Bot API calls the underlying primitive a `Topic` / `ForumTopic`, but project language follows user-perceived client reality rather than API naming. Use **topic** only when discussing Bot API method names, service-message names, or transport-level evidence. User/operator UX and product docs should say thread.

This document supersedes the narrower API-topic framing. Telegram threads are a UI/routing substrate, but the deeper design problem is multi-instance coordination: one bot token has one Telegram API update bus, while multiple live Pi agent instances may want to expose their own Telegram workspace through that bus.

## Problem

Classic `pi-telegram` mode binds one private Telegram DM to one live Pi instance through one bot token and one singleton polling owner. The lock currently answers: "which Pi instance owns Telegram control/polling?"

That model is safe, but it leaves concurrency on the table:

- Only one live Pi instance can receive Telegram updates for a bot token.
- Moving `/telegram-connect` changes the active Telegram control owner instead of letting several instances coexist.
- Multiple projects, tmux panes, remote workers, or long-running Pi instances require separate bot tokens or manual ownership switching.
- A thread workspace is only useful if it routes to a live agent instance, not to a dead session record that can no longer answer.

Telegram itself has one relevant constraint: for a bot token, `getUpdates` must be owned by one poller. The architecture must embrace that by electing one local Telegram bus leader and routing work to follower instances.

## Goal

Support a Threaded Mode multi-instance runtime where:

```text
one bot token -> one local Pi organism -> ephemeral bus leader -> many live Pi instances -> many Telegram targets
```

The leader is a temporary transport role, not the ontological owner of the system. A terminal-visible Pi instance may become the initial leader because it is the operator's visible harness, while additional terminal-visible Pi instances can explicitly register as followers through `/telegram-connect` and one of them can later take over bus leadership if the leader exits.

A practical Telegram UI can then use threads:

```text
one private bot chat -> one thread per live Pi instance
```

The operator experience:

1. Start one Pi instance; it becomes the Telegram bus leader and polls Telegram.
2. Start another Pi instance with `pi-telegram` and run `/telegram-connect`; the follower registers instead of fighting for `getUpdates`.
3. The leader provisions or reuses a Telegram thread target for that instance.
4. Messages, callbacks, reactions, files, voice, previews, and menus in that target route to the owning live Pi instance.
5. If the leader exits, remaining followers elect/promote a new leader, which resumes polling and keeps the registered target routes alive where possible.

## Non-goals

- Do not let more than one process call `getUpdates` for the same bot token.
- Do not treat Telegram as a raw terminal, PTY, or process supervisor.
- Do not couple the first design to Pi sessions if live instance ownership is the better runtime truth.
- Do not expose arbitrary group participants to prompts, controls, or artifacts.
- Do not require Threaded Mode for classic private-chat users; classic private-chat mode remains valid and should not receive slot/thread-name guidance.
- Do not implement leader election through unsafe lock stealing without heartbeats or stale-owner checks.

## Terms

- `Telegram bus`: The singleton local capability to poll Telegram updates and send Telegram API calls for one bot token.
- `Leader`: The live Pi instance that currently owns the Telegram bus and calls `getUpdates`; this is an ephemeral role transferable after stale heartbeat detection.
- `Follower`: A live Pi instance that wants Telegram presence but routes Telegram API access through the leader.
- `Bus lifecycle`: Transient recovery state only. Stable identity is the bus role (`leader` / `follower`); lifecycle surfaces exceptional handoff states such as `electing`, not duplicate roles with labels like `leader-active`.
- `Agent instance`: A running Pi process/session with its own extension state, queue, active turn, model, tools, and lifecycle hooks.
- `Telegram target`: The concrete Telegram destination for an instance, represented as `{ chatId, threadId? }`.
- `Thread target`: A Telegram UI thread destination, represented as `{ chatId, threadId: message_thread_id }` over Bot API topic transport.
- `Classic target`: The existing private-chat target, represented as `{ chatId: allowedUserId }`.

## Core Shift

In Threaded Mode, the lock means "this instance is the current Telegram bus leader" rather than "this instance is the only usable Telegram extension".

Classic lock meaning:

```text
locks.json / @llblab/pi-telegram -> polling/control owner
```

Threaded Mode meaning:

```text
locks.json / @llblab/pi-telegram -> bus leader identity + heartbeat
```

Followers do not poll. They register with the leader and receive routed inbound updates from it. Followers still own their local queue, active-turn state, previews, final delivery planning, model switches, and Pi lifecycle. The leader owns only Telegram transport and update fanout. Pi session replacement (`new`) changes follower agent context, not bus membership: a registered follower preserves its registration and refreshes the live context instead of disconnecting. The Telegram bus belongs to the local set of cooperating visible Pi instances rather than to the first terminal session forever: if the visible terminal leader exits, a live registered follower can take over leadership.

## Target Abstraction

The bridge uses a first-class target abstraction:

```ts
type TelegramTarget = {
  chatId: number;
  threadId?: number;
};
```

Private-chat mode uses `{ chatId: allowedUserId }`.

Threaded Mode uses `{ chatId: privateChatId, threadId: messageThreadId }` over Bot API topic transport.

Every session/instance-scoped path carries or preserves a target:

- Inbound update routing.
- Queue item identity.
- Active turn state.
- Preview draft state.
- Final replies and reply deduplication.
- Voice and attachment uploads.
- Menu/status/settings/queue/section messages.
- Button callback ownership.
- Reactions.
- Typing/record-voice chat actions.
- Direct local/TUI Telegram delivery.

## Binding Model

A thread maps to a currently running Pi instance, not to a historical session file. `instanceId` is the live routing owner, while `instanceProfileKey` is a reuse hint for reclaiming a compatible current thread across process replacement.

```text
runtime owner: live instance id
reuse hint: cwd/profile/user-chosen alias/session id when available
```

This keeps thread liveness honest: if an instance is registered, there is a live owner to answer. It also avoids coupling `/new`, compaction, and session-file internals to Telegram routing. Restarted projects may still reclaim previous current bindings through profile-aware reuse when that does not conflict with live ownership.

## Instance Identity

A registered instance exposes:

```json
{
  "instanceId": "uuid-or-runtime-id",
  "pid": 12345,
  "cwd": "/home/user/project",
  "startedAt": "2026-05-20T10:00:00.000Z",
  "owner": { "kind": "leader", "cwd": "/home/user/project" },
  "threadName": "<valid-instance-identity>",
  "target": { "chatId": 123456789, "threadId": 42 },
  "status": "idle|active|queued|compacting|disconnected",
  "lastHeartbeatAt": "2026-05-20T10:00:05.000Z"
}
```

`instanceId` is liveness identity. `owner` is explicit current binding identity (`leader`, `manual-follower`, or `pending-topic`). Internal compatibility keys may be derived, but `state.json` should not hide ownership direction inside legacy string keys. `threadName` is the user-facing instance-thread name: it drives Telegram UI thread naming and the Telegram-originated prompt identity label. Fresh threads receive a baked compact thread name from the assigned slot's curated palette; bare slot labels are fallback state only, and role/cwd seeds never replace the thread label.

## Leader Election

Leader election is heartbeat-gated and lock-backed:

1. On startup, read the Telegram lock.
2. If no leader exists, acquire leadership and start polling.
3. If a live leader exists, register as follower.
4. If the leader heartbeat is stale, attempt an atomic leadership takeover; ordinary `/telegram-connect` on a follower is not a leadership move while the leader is live.
5. If several followers detect stale leadership, atomic compare/write lock acquisition ensures only one becomes leader.

Followers first try to re-register after leader reload or unknown-heartbeat responses, then promote only after the grace window expires. This preserves thread bindings through transient reload gaps without allowing competing pollers.

## Leader/Follower Communication

Implemented transport:

### Local IPC endpoint under agent temp dir

Leader opens a local Node `net` endpoint: a Unix-domain socket under the agent temp directory on Unix-like platforms, or a deterministic Windows named pipe (`\\.\pipe\pi-telegram-...`) on native Windows. Followers register, heartbeat, and exchange routed events. The transport boundary owns endpoint derivation, socket-vs-pipe detection, bounded operation-aware retry policy, timeout/transient IPC error classification, endpoint reachability probes, and request-scoped transport events. Follower registration uses a longer registration-specific response timeout than ordinary heartbeat/forwarding calls because the leader may need to provision a Telegram thread before it can return the assigned target; timing out that handshake leaves a visible tab with no follower heartbeat. Keep this handshake to the true critical path: create/reuse the target, persist the live binding, and return it. Connected notices and replaced-thread reconciliation cleanup are non-critical and should run after registration so a follower becomes routable before Telegram client/server UI convergence work finishes.

Pros:

- Natural request/response for sending Telegram API calls through the leader.
- Can route inbound updates to followers while preserving one poller.
- Good fit for live process membership.

Cons:

- Adds IPC lifecycle and security concerns.
- Cross-machine workers need tunneling or a different transport.

Alternative transports such as file-backed mailboxes or an external daemon remain out of the current product boundary. Local IPC is the default internal bus while the public design stays compatible with a future daemon if deployment needs outgrow one host.

## Native Windows Smoke Plan

Native Windows support should not require WSL. The baseline transport uses Windows named pipes for leader/follower IPC, but live verification still needs an operator with a native Windows Pi install.

Manual smoke checklist:

1. Enable Telegram private-chat Threaded Mode for the paired bot.
2. Start Pi in one Windows terminal and run `/telegram-connect`; verify it becomes the leader and gets a named Telegram thread.
3. Start Pi in a second Windows terminal and run `/telegram-connect`; verify it registers as follower rather than offering takeover, creates/uses its assigned thread, and terminal status shows `<ThreadName> Follower`.
4. From the follower thread, send a prompt that requests inline buttons; tap a button and verify the follow-up prompt queues in the follower instance.
5. From the follower thread, request a voice reply and/or attachment; verify upload routes through the leader transport into the follower thread.
6. Close the follower terminal; verify heartbeat pruning, disconnected notice, and cleanup behavior match Unix-like behavior.
7. Reload the leader and verify status/debug output does not expose raw pipe internals except in explicit diagnostics.

If any step fails, capture `telegram-status --debug`, `tmp/telegram/state.json`, `tmp/telegram/logs.jsonl`, and, after a reload, `tmp/telegram/logs.previous.jsonl`. Debug status prints local leader/follower endpoints with their active transport kind (`pipe` or `socket`), while the runtime log records request-scoped transport failures with envelope kind, request id, retry attempt, endpoint, and classified IPC error. Reloads preserve the prior JSONL log as `logs.previous.jsonl` so the evidence that caused the reload is not immediately overwritten.

### Native Windows Assumption Audit

Current portability audit:

- Local bus transport: adapted. Unix-like platforms use filesystem socket paths; native Windows uses named pipes so no POSIX socket pathname is required.
- Bus endpoint permissions: Unix sockets/directories use `chmod`; Windows named-pipe endpoints skip POSIX chmod/unlink path handling because the pipe is not a filesystem node.
- Shared lock/config/state/temp files: path construction uses `path.join`/`path.resolve` under the Pi agent directory. File permission calls remain best-effort private-mode hardening; native Windows may emulate POSIX modes, so broad Windows ACL auditing is outside this extension's current local-bus baseline.
- Process liveness: lock ownership uses `process.kill(pid, 0)`, which Node supports on Windows for existence checks. Cross-user permission failures are treated as alive, matching Unix semantics.
- Shell/provider commands: outbound handler command templates remain operator-configured and platform-dependent; Threaded Mode bus portability does not guarantee every configured STT/TTS/shell provider is Windows-native.
- Manual follower identity: process ids are used as local liveness/profile hints only, not cross-machine identifiers.

Remaining risk is live native Windows behavior: named-pipe creation/connect timing, antivirus/firewall/ACL interference, and provider command availability need operator smoke evidence.

## Telegram Thread UX

In Telegram private-chat Threaded Mode:

- The private bot chat is a tabbed instance workspace, not a classic `General + threads` forum.
- `All` is an aggregate view, not a process launcher. Explicit new instances use live Pi follower registration: the operator starts Pi in a terminal and runs `/telegram-connect`; owner-created empty threads are observed but not treated as a Pi instance until the user chooses a route or restore action.
- The leader proactively creates or reclaims its own thread on startup/activation when Threaded Mode is available, so the visible leader has the same two-way binding as followers.
- **Unbound thread detection**: when the owner writes in an unknown `message_thread_id`, the bridge checks effective Threaded Mode state. If the current leader has no active bound thread, that new thread is reclaimed for the leader and the prompt is served locally. Otherwise the bridge preserves the prompt in that Telegram thread and shows a target-thread chooser; explicit routing may later close/delete only extra confirmed source threads through `thread-reconciler`.
- Unknown later threads and threadless prompt messages are not silently routed to the leader and never launch hidden Pi processes. The default and only operator path for a new visible instance is starting a visible second Pi process and letting it register as follower through `/telegram-connect`. Manual follower registration creates a fresh visible thread unless the same explicit binding identity already has a live binding; old offline/failed records may point at closed/deleted Telegram tabs and are not silently claimed.
- Thread lifecycle service messages (`forum_topic_created`, `forum_topic_closed`, `forum_topic_reopened`, deletion/stale send errors) update observations and binding state. Closed/deleted leader or follower threads can be reclaimed or recreated deliberately. Leader startup also probes reused own threads with a non-visible chat action; if Telegram reports the thread closed/deleted, the binding is marked stale and a fresh leader thread is created. Unknown `forum_topic_created` service events are observation-only and are not destructive cleanup proof.
- Bidirectional binding is a core UX requirement, not an implementation detail: Pi instances actively advertise/remember their thread identity, while the bot observes Telegram-client thread state and reflects it back into instance state. This keeps the system responsive, recognizable, and controllable even when the operator closes tabs, writes from `All`, or a follower later becomes leader.

In Telegram private-chat Threaded Mode:

- The private bot DM becomes the operator's multi-instance dashboard.
- Each live bound instance gets one visible thread.
- Each instance has a durable single-letter slot (`A`-`Z`) assigned by the extension and a bridge-authored `threadName`.
- New slots advance monotonically through the alphabet and wrap after `Z` only to a free slot; closed earlier slots are not backfilled out of order. This preserves sequence feel and intentionally caps concurrent visible instances to the alphabet without duplicating occupied letters. The compact `bot.lastSlot` cursor persists across reloads and live-test history, so after `Z` the next truly new thread can be `A` again when `A` is currently free.
- A follower that later becomes leader keeps its existing slot and thread name; leadership changes are transport role changes, not identity resets.
- Instance-thread names are short and recognizable. Default provisioning chooses one baked 4-6 letter single-word Latin thread name from the assigned slot's five-name palette using provisioning timestamp entropy and creates the Telegram thread with that title immediately. The slot remains internal ordering metadata and is not redundantly included in the thread name. Bare slot titles are fallback/legacy state only; do not prompt agents to self-name and do not expose a rename tool. Existing human-named threads are preserved across reloads and leadership changes when they remain the current live binding. If reload creates a new runtime instance while the previous leader thread is still alive, the new leader should take the next free slot instead of reusing the old slot immediately.
- A thread-local `/start` opens that instance's menu.
- Prompts typed in a thread route to the owning instance.
- Replies, previews, files, voice, and buttons stay in that thread.
- Queue controls and reactions affect only that instance target.
- Native typing/activity for real work is sent to that instance thread and mirrored to `All`; `All` is the aggregate surface and should show active when any bound thread is active. Startup/connect/reload/recovery must not send typing by themselves.
- If the instance disconnects, the leader can post/update a compact status: `Instance offline`.
- If the same live binding identity returns, it can reclaim the thread and post a compact reconnect status.

## Bot API Evidence For Private-Chat Threaded Mode

The local Bot API reference in [`../.agents/skills/telegram-bot/api.md`](../.agents/skills/telegram-bot/api.md) supports private bot Threaded Mode through bot capability fields and thread-target transport:

- `User` returned by `getMe` can include `has_topics_enabled` and `allows_users_to_create_topics`; these are the private-chat Threaded Mode capability fields and are the startup/runtime probe source for this extension.
- `createForumTopic` works in a private chat with a user and returns a `ForumTopic`, so the returned `message_thread_id` is persistable as an instance thread target.
- Private-thread management uses Bot API methods such as `editForumTopic`, `closeForumTopic`, `reopenForumTopic`, `deleteForumTopic`, and related unpin methods. Thread-unavailable errors from these methods are degradation evidence when Threaded Mode is disabled or unavailable for the bot.
- `Message` exposes `message_thread_id` and `is_topic_message`; an incoming private-chat message with `message_thread_id` is a live Threaded Mode observation and can trigger progressive upgrade.
- Topic lifecycle service messages include `forum_topic_created`, `forum_topic_edited`, `forum_topic_closed`, `forum_topic_reopened`, `general_forum_topic_hidden`, and `general_forum_topic_unhidden`.
- `message_thread_id` is supported by the send/upload methods the bridge uses or may need: `sendMessage`, `sendPhoto`, `sendDocument`, `sendVoice`, `sendMediaGroup`, `sendSticker`, `sendRichMessage`, `sendMessageDraft`, `sendRichMessageDraft`, and `sendChatAction`.

Non-goal: group detection is not the control-plane model for this extension. Threaded Mode lives in the private bot chat, so startup and runtime switching must not depend on group chat metadata or group admin capability fields.

Remaining live-verification points:

- Whether callback query messages always carry `message_thread_id` in private bot threads, or whether generated button callbacks must rely on stored message id -> target ownership.
- Whether message-reaction updates carry thread identity in the current Bot API shape. The reference exposes chat id and message id for reactions, so routing may need stored message ownership.
- Whether every rich draft/final/upload/chat-action path behaves identically in Telegram clients when `message_thread_id` is supplied.

Implemented behavior stays evidence-gated: when Telegram client or Bot API behavior differs from the contract above, capture a minimized fixture or documented client caveat before changing routing.

## Inbound Routing

The leader polls all updates for the bot token. It classifies each update into a target key:

```text
targetKey = chatId + ':' + (threadId ?? 'private')
```

Then it dispatches:

- If target belongs to the leader instance, handle locally.
- If target belongs to a follower, forward the normalized update/event to that follower.
- If target is unknown but authorized and setup allows provisioning, offer or create a binding.
- If target is unknown or unauthorized, ignore or send a safe denial.

Follower instances receive normalized events, not raw Telegram transport internals where possible. The follower still runs the same queue/routing logic, but Telegram API calls go back through the leader transport port.

## Outbound Routing

Followers do not call Telegram Bot API directly for routed Telegram work. Instead, they call a leader-owned transport port:

```text
follower reply/preview/upload/chat-action/download/callback-answer -> leader IPC -> Telegram API
```

This preserves one API bus and one set of rate-limit/retry diagnostics. The current local bus routes JSON calls, multipart uploads, chat actions, message deletes, callback/guest answers, and file downloads through the leader when a follower is registered.

Every outbound request carries its target. The leader injects `message_thread_id` when `target.threadId` exists.

## Queue And State Scoping

Each instance owns its own queue and active turn state. The leader does not become a central queue scheduler for all agents; that would be a separate daemon-mode architecture.

Target-scoped state requirements:

- Queue item identity includes target plus source message id.
- Reply deduplication is keyed by target, not just chat id.
- Preview draft state is keyed by target.
- Button callbacks store target and owning instance id.
- Reactions resolve to target/instance before mutation.
- Attachments generated by a follower are uploaded by the leader into the follower's target.

## Configuration

There is no public `telegram.json` switch for the bus. Telegram private-chat Threaded Mode is the runtime switch: when Telegram exposes threads for the bot, the bridge enables the local bus; when Telegram runs as an ordinary private DM, the bridge uses classic private-chat flow as the base mode.

Typical config remains just bot identity and authorization:

```json
{
  "botToken": "...",
  "allowedUserId": 123456789
}
```

Rules:

- Classic mode is selected by Telegram capability: when private-chat threads are unavailable or disabled, the polling owner uses ordinary single-DM behavior and blocked instances do not register as followers. During a live downgrade from Threaded Mode, the current bus leader becomes the classic polling owner after two 2.5-second capability-monitor probes and followers disconnect; if classic polling restore fails transiently, later monitor ticks retry the restore instead of allowing a follower takeover. Followers must not turn the downgrade into a takeover while active thread bindings prove the singleton owner was already established by the bus leader.
- Telegram private-chat Threaded Mode enables local leader/follower behavior automatically. The leader owns `getUpdates`; registered followers route Telegram API work through the leader. `/telegram-connect` registers as follower when a live leader exists and does not offer manual takeover in that state. The TUI status bar reports `telegram leader` or `telegram follower` so transport role is visible without opening diagnostics.
- The thread chat is the owner's private bot DM (`allowedUserId`); no `topics.chatId` config is needed. Thread names are assigned by the bridge from a baked compact per-slot palette. There is no agent-facing `telegram_rename_thread` tool and no separate user-facing slash command for manual thread renames.
- Thread reuse is extension-owned through current live binding identity; there is no separate `topics` config surface in the active private-chat thread model. Manual followers use instance-scoped internal keys by default so multiple terminal processes in the same cwd can receive separate threads.
- Thread cleanup remains conservative and centralized: destructive close/delete actions are planned and applied through `thread-reconciler` with proof-before-delete checks, leader-epoch fencing, and retry-preserving failure semantics.
- `allowedUserId` remains the primary authorization boundary unless explicit allowlists are added. Forum/group membership alone must not grant control.

## Runtime State

Current state under the agent dir:

- `locks.json`: current bus leader identity, capability secret, heartbeat, and cleanup fencing epoch. The local bus endpoint is derived from the agent directory by default; legacy `busSocketPath` entries are tolerated but are not required.
- `tmp/telegram/state.json`: volatile extension+bot observable/debug snapshot, not routing authority. It writes `source: "snapshot"` and `writtenAtMs` so consumers do not confuse it with an authoritative database. It mirrors `/telegram-status`-style projections: top-level `bot` stores bot-wide capability state such as `threadMode: "unknown" | "enabled" | "disabled"`, `runtime` identifies leader/follower role and process status, `liveRoster` mirrors followers/current targets/reservations, `diagnostics` mirrors status/debug signals, `threads` stores current routeable bindings, `bot.lastSlot` stores the compact slot cursor used when all current threads are gone, and `reservations` records short-lived slot collision guards.
- Local bus endpoints: Unix-like platforms use `tmp/telegram/bus.sock` and `tmp/telegram/followers/*`; native Windows uses deterministic named pipes under `\\.\pipe\pi-telegram-...`. These are transient IPC endpoints, not durable routing state.

The bridge must not keep a durable `telegram-targets.json` history. Stale/offline/failed thread entries are reconciliation observations, not reusable source-of-truth state; persisting them increases collision risk. `sync` is event-driven assumption reconciliation, not full Telegram bot-state mirroring, because Bot API does not expose a complete topic/thread listing surface. `state.json` therefore exists for extension+bot observability, diagnostics, startup hints, and explaining reconciliation decisions; live bus/runtime state remains authoritative for routing and provisioning. Non-current routeable thread bindings are pruned during load/persist; old session records must not be retained just to compute the next slot because `bot.lastSlot` is the only durable cursor. Previous-process leader bindings are treated as occupied TTL-bounded reservations until Telegram confirms deletion: reload/startup may close/delete/probe the old thread, known reservations are retried proactively on leader startup, and if Telegram still accepts the old thread id, the new leader should provision the next free slot (`B`, `C`, …) rather than creating a duplicate same-letter tab or blocking startup on Telegram UI convergence. Routing must use live current threads/follower registry, never reservations. The bus leader provisions its own thread during bus startup/connect and provisions follower threads on `follower.register`; registered followers also live in the leader's in-memory registry and communicate over the local bus socket. The live follower registry can resolve a follower by exact `{ chatId, threadId? }`; the leader uses that target ownership to forward message and edited-message updates to followers, and the follower receiver accepts those updates in addition to callbacks and reactions. Media album grouping and split-text coalescing keys include the thread target, queue reaction mutations can scope by chat/thread to avoid cross-target message-id collisions, active-turn target is exposed for lifecycle cleanup and local direct-tool defaults, transport reply dedup is chat/thread-scoped, stored menu state is keyed by chat/message so callback state lookup cannot collide across chats, and generated button turns plus section prompt/open actions preserve the callback thread target. `telegram_message` and immediate `telegram_attach` delivery can also carry an explicit `thread_id` with `chat_id`; when a follower is registered, their default direct-tool target is the assigned thread target and the bus-aware API runtime routes the send through the leader instead of calling Bot API transport locally.

All files containing routing, chat ids, thread ids, or process details use private permissions and represent current state rather than historical target caches.

## Failure Modes

### Leader exits cleanly

- Leader stops polling and marks itself offline.
- Followers detect missing heartbeat.
- One follower promotes itself after jitter/tie-break.
- New leader resumes `getUpdates` from the persisted offset if safe.

### Leader crashes

- Followers detect stale heartbeat.
- One follower promotes itself.
- Some updates may be delayed or skipped depending on offset persistence; dispatcher design must define this explicitly.

### Follower heartbeat is missed

- Leader prunes the follower from the live registry after missed heartbeats, but heartbeat pruning is only liveness bookkeeping.
- A missed heartbeat does not delete, close, mark offline, or send a disconnected notice for the follower's Telegram thread binding because the common cause may be leader reload, IPC handoff, or transient reconnect rather than a dead follower.
- Followers treat rejected/missing heartbeat acknowledgements as registration loss: clear local registered truth, try to re-register with the current leader, wait a short leader-reload grace window, retry, and then promote themselves if the leader still cannot route them.
- Every successful follower registration/re-registration sends a compact connected notice in the assigned thread so recovery and reconnection are visible during live testing without confusing heartbeat suspicion with real disconnect.
- Successful forwarded updates and follower-originated API calls refresh liveness, so active followers are not pruned only because the interval heartbeat tick lagged.
- Destructive follower thread teardown belongs to explicit `/telegram-disconnect` or confirmed reconciliation actions, not generic heartbeat pruning.
- Historical offline thread entries are not retained as reusable source of truth.

### Thread is deleted

- Target mapping becomes stale.
- On next outbound failure or reconnect, leader records a diagnostic.
- Depending on policy, recreate a thread or mark the instance as needing operator action.

### Split brain

- Two leaders calling `getUpdates` is the main safety failure.
- Lock heartbeat/takeover must be atomic enough to prevent this under normal local concurrency.
- If Telegram returns API conflict behavior, record diagnostics and force one leader to step down.

## Security Boundaries

- Messages, edits, callbacks, and reactions check user authorization, not only chat/thread membership.
- Followers authenticate to the local leader IPC with a leader-minted capability secret carried in the active lock entry; registration, heartbeat, forwarded updates, and follower API calls without the secret are rejected. Registration rejections are surfaced verbatim in the follower `/telegram-connect` result, registration waits through leader-side Telegram thread provisioning, and successful registrations send an immediate heartbeat before the interval ticker so the leader does not prune a live follower before its first scheduled heartbeat. The local bus socket is also created under a private `0700` directory with `0600` socket permissions as a first local-only boundary.
- Follower Bot API proxying is allowlisted and target-scoped where applicable so a follower can reply in its assigned thread without gaining arbitrary bot control.
- Button and section callbacks verify authorized `from.id` and owning target/instance.
- Generated artifacts stay scoped to the owning thread after leader failover.
- Diagnostics redact bot tokens, large prompts, attachment paths, and handler output.

## Acceptance Criteria

- [x] The lock semantics are redesigned as Telegram bus leadership with heartbeat and stale takeover rules.
- [x] A first-class `TelegramTarget` can represent classic private chats and thread destinations.
- [x] The bridge can run in classic mode with unchanged private-chat behavior.
- [x] A live Pi instance can register as a follower when another live instance is leader.
- [x] Followers never call `getUpdates` for the shared bot token.
- [x] Followers can send replies, previews, voice, attachments, menus, and chat actions through the leader transport.
- [x] The leader can route inbound messages, edits, callbacks, reactions, media groups, and split text to the owning instance by target. Message/edit and callback/reaction routing is authorized by user id; media and split-text coalescing are target-keyed locally.
- [x] Telegram UI thread targets can be provisioned as current state bindings; stale/deleted Telegram observations and explicit disconnect/reconciliation actions remove unusable bindings instead of persisting reusable history, while heartbeat-pruned followers preserve their thread binding so transient leader reload/reconnect gaps do not create split-brain Telegram UX.
- [x] Leader failover promotes one remaining follower without creating competing pollers.
- [x] Queue, active turn, preview, reply deduplication, menu, section, button, reaction, and attachment state are scoped by instance/target. Queue reaction mutations and transport reply dedup are chat/thread-scoped; active-turn target is available to lifecycle cleanup; stored menu state is chat/message-keyed; generated button turns and section prompt/open actions preserve callback targets; preview and attachment delivery already carry targets.
- [x] Authorization prevents arbitrary Telegram users or local processes from controlling agents or receiving artifacts.

Live client and native Windows evidence gates are tracked in `BACKLOG.md`; this architecture document records the implemented contract, not the active smoke queue.

## Implemented Shape

- Bus semantics are the feature frame: Telegram threads are one Telegram UI substrate for a local multi-instance bus.
- `TelegramTarget` and target-key helpers represent classic private chats and thread destinations.
- Outbound ports, previews, replies, voice, attachments, chat actions, menus, sections, buttons, queue mutations, and direct local delivery carry target metadata where needed.
- The transport lock distinguishes live bus leadership from ordinary classic ownership through heartbeat, leader epoch, and stale takeover rules.
- The leader records live follower registration, heartbeat, thread identity, slot, and target mapping; followers do not poll `getUpdates`.
- Local IPC is the default internal bus. Registered followers receive normalized inbound updates and send allowlisted, target-scoped Bot API calls through the leader.
- Thread targets are current-state bindings, not durable historical delivery addresses. Stale/offline/failed entries are reconciliation evidence only.
- Failover promotes a remaining follower after dead or clean-disconnected leaders without creating competing pollers; follower heartbeat recovery owns re-register → grace → promotion while preserving thread bindings across transient leader reload gaps.
- Thread cleanup is centralized in `thread-reconciler`, fenced by leader epoch, and requires confirmed delete/stale evidence before state is marked deleted.
- Stable docs/UI now describe classic mode, opt-in Threaded Mode, manual follower registration, status/diagnostics, unbound-thread reroute/restore UX, and operator recovery boundaries.

## Evidence Gates

Open live/client questions belong in `BACKLOG.md` until confirmed. Capture confirmed quirks as focused regressions or documented caveats, not broad speculative matrices.
