# Telegram Bridge Architecture

## Purpose

`pi-telegram` is a session-local π extension that binds one Telegram DM to one running π session. It owns the Telegram bridge boundary:

- Poll Telegram updates and enforce single-user pairing.
- Translate Telegram text, callbacks, media, and files into π turns.
- Stream previews and deliver final π responses back to Telegram.
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

## Runtime Topology

`index.ts` is the only composition root. It wires live π ports, Telegram Bot API ports, session-local stores, lifecycle hooks, and domain runtimes. Reusable logic lives in flat `/lib/*.ts` domain modules rather than a deep local module tree.

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
- `locks` / `polling`: singleton polling ownership, takeover/restart behavior, long-poll controller state, offset persistence, and poll-loop wiring.
- `updates` / `routing`: update classification, authorization planning, callbacks, edited messages, reactions, and inbound route composition.
- `media` / `text-groups` / `time-injection` / `turns` / `inbound`: inbound text/media/file extraction, media-group debounce, long-text coalescing, optional `[time]` context, handler execution, and prompt-turn assembly/editing.
- `queue`: queue item contracts, lane admission/order, readiness gates, mutations, dispatch runtime, prompt/control enqueueing, and session/agent/tool lifecycle sequencing.
- `runtime`: session-local coordination primitives: counters, flags, setup guard, abort handler, typing timers, dispatch flags, and reset binding.
- `model` / `menu-model` / `menu-thinking` / `menu-status` / `menu-queue` / `menu-settings` / `menu` / `commands`: model identity, thinking levels, scoped model handling, menu render/callback behavior, slash commands, bot commands, and interactive controls.
- `sections`: Telegram menu-section registry, opaque section callback tokens, render/callback dispatch, safe section ports, and diagnostics.
- `keyboard`: shared inline-keyboard reply-markup shape only; feature domains own labels, callback data, and behavior.
- `preview` / `replies` / `rendering`: streaming preview lifecycle, final reply delivery, reply parameters, Telegram HTML rendering, chunking, and stable preview snapshots.
- `outbound-markup`: top-level assistant action comment parsing, attribute parsing, voice reply planning, and preview/delivery stripping.
- `outbound`: outbound text transformations, voice/button artifact delivery, and generated callback actions.
- `outbound-attachments`: `telegram_attach`, queued outbound files, stat/limit checks, and photo/document delivery classification.
- `status`: status bar/status-message rendering, queue-lane summaries, redacted event ring, and grouped diagnostics.
- `lifecycle` / `prompts` / `prompt-templates` / `pi`: π hook registration, Telegram prompt guidance, prompt-template discovery/expansion, and centralized direct π SDK imports.
- `command-templates`: shell-free command-template helpers, composition expansion, placeholder substitution, executable resolution, warnings, and retry/timeout semantics.

### Guarded Invariants

Architecture invariant tests protect:

- Acyclic local imports.
- Direct π SDK imports centralized in the `pi` adapter.
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
- `/telegram-disconnect` stops polling and releases ownership.
- Session start resumes polling only when the existing lock already points at the current `pid`/`cwd`, or when a stale same-`cwd` lock can be safely replaced after process restart.
- Pi `print`/`json` run modes stay passive: they do not start or resume Telegram polling even if a lock is present. Older Pi runtimes without `ctx.mode` keep the previous compatibility behavior.
- Inherited child sessions that see the same `telegram.json` but do not own the `pid`/`cwd` lock must not auto-start polling or call `getUpdates` unless the operator force-takes ownership.
- Session replacement suspends polling/watchers without releasing ownership so the next session-start hook in the same process can resume.
- Live polling owners require explicit takeover confirmation.
- Long-lived polling timers use snapshotted ownership context and stop local polling when the lock no longer points at their own process.
- `locks.json` owns only external Telegram control/polling. Local extension and queue state are per Pi instance: losing the lock stops live Telegram control here, but does not drain or silence this instance's accepted queue, previews, final delivery, or dispatch.
- Proactive local/headless final-result push is not accepted-turn delivery. It is allowed only when proactive push is enabled and this instance currently owns the Telegram lock.

Deleting `locks.json` resets runtime ownership without deleting Telegram configuration.

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
- No pending Telegram dispatch already sent to π.
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
- `/next` dispatches the next queued turn, aborting π first when needed.
- `/abort` aborts active work while preserving queued items. Abort-history preservation is enabled only for Telegram-owned active turns; later local/non-Telegram agent starts clear stale abort-history mode so the next Telegram prompt appends instead of absorbing old queued turns as history.
- `/stop` aborts and clears waiting Telegram queue items.

Queued controls:

- `/continue` creates a priority Telegram-owned `continue` prompt.
- Prompt-template commands expand Telegram-safe π template aliases before entering the prompt queue.
- Model-switch continuation uses the control lane when an in-flight Telegram-owned run must be stopped and resumed.

Queue and menu mutations are reachable through Telegram updates handled by the current polling owner. After ownership moves, the old instance keeps processing its accepted local queue, but it no longer receives new menu callbacks or control updates for remote mutation. UI label, navigation, tab, toggle, card, and dialog rules are defined in [UI Style](./ui-style.md). Callback prefix ownership is defined in [Callback Namespaces](./callback-namespaces.md).

### Compaction And Typing Status

Manual `/compact` requires inline confirmation because accidental taps are disruptive. Auto-compaction and confirmed manual compaction both:

- Set the bridge compaction flag.
- Block queued prompt dispatch.
- Update status to `compacting`.
- Start Telegram native `typing` keepalive.
- Stop typing on compact completion, timeout fallback, or session shutdown.

During active Telegram-owned turns, assistant message start/update hooks re-arm typing so transient provider/model errors do not leave a continuing run without Telegram activity feedback.

### Rendering And Delivery

Telegram replies are rendered as Telegram HTML, not raw Markdown. The renderer is Telegram-specific and regression-prone.

Key guarantees:

- Real code blocks stay literal and escaped.
- Supported absolute links stay clickable; unsupported links degrade safely.
- Markdown tables render as compact monospace blocks and count grapheme/display width.
- Lists, task lists, quotes, headings, and blank-line spacing have Telegram-specific preservation rules.
- Long replies are chunked below Telegram limits with balanced HTML where possible.
- Streaming previews prefer stable rich blocks and append the unstable tail conservatively as readable plain text.
- Preview flushes are serialized so older edits cannot race newer snapshots.

Final delivery attaches reply metadata only where requested. Reply parameters apply only to the first chunk of split messages; continuation chunks are adjacent normal messages. Media-group turns reply to the representative message id.

### Outbound Artifacts And Assistant Actions

Outbound files staged during an active Telegram turn are delivered after that turn completes. They use `telegram_attach`, are checked atomically per tool call, and use configurable size limits before photo/document upload. When no Telegram turn is active, `telegram_attach` sends files immediately to the paired/default chat or explicit `chat_id`; `telegram_message` provides direct local/TUI Markdown text delivery for explicit user requests and runs the same `telegram_button` markup planner so buttons attach to that text message. Direct local/TUI delivery is singleton-controlled: it requires this π instance to own `/telegram-connect`, while already accepted active-turn reply/attachment delivery remains session-local.

Assistant-authored final-message actions use hidden top-level comments:

- `telegram_voice` creates voice reply artifacts through configured outbound handlers, programmatic voice handlers, or registered synthesis providers.
- `telegram_button` creates inline buttons whose callbacks enqueue the configured prompt text as a normal Telegram prompt turn.

Preview rendering strips top-level action comments while streaming. Comments inside code fences, quotes, lists, or indented examples stay literal.

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

When `/model` is used during an active Telegram-owned run, the bridge can emulate π's interactive stop/switch/continue workflow:

1. Apply the selected model immediately.
2. Queue or stage a synthetic Telegram continuation turn.
3. Abort the active Telegram turn immediately, or wait for the current tool to finish before aborting.
4. Dispatch the continuation after abort completion.

This is limited to Telegram-owned runs. If π is busy with non-Telegram work, the bridge refuses the switch instead of hijacking unrelated activity.

## Shutdown And Timer Lifecycle

`session_shutdown` is the hard boundary for session-bound runtime work. It suspends Telegram polling through the locked polling runtime, aborts the poll controller, stops native typing, unbinds deferred queue dispatch, clears pending media/text-group input, clears preview state, clears active turns, and drops the active abort handler.

Non-critical timers are `unref()`ed so print/headless processes are not kept alive only by Telegram housekeeping. This includes typing keepalive intervals, bounded typing-idle waits, deferred queue dispatch, media/text-group debounce windows, preview flush timers, and polling retry sleeps. Polling retry sleep is abort-aware, so shutdown does not wait for the normal retry delay after a polling error.

Non-interactive `pi -p` runs must remain passive unless π provides a live Telegram session lifecycle. Loading the extension with `telegram.json`, proactive push settings, or existing lock state must not by itself keep the print-mode process alive or let a non-owner send proactive Telegram output.

## Related

- [README.md](../README.md)
- [Project Context](../AGENTS.md)
- [Project Backlog](../BACKLOG.md)
- [Changelog](../CHANGELOG.md)
