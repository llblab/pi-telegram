# Telegram Bridge Architecture

## Overview

`pi-telegram` is a session-local pi extension that binds one Telegram DM to one running pi session. The bridge owns four main responsibilities:

- Poll Telegram updates and enforce single-user pairing
- Translate Telegram messages and media into pi inputs
- Stream and deliver pi responses back to Telegram
- Manage Telegram-specific controls such as queue reactions, `/status`, `/model`, `/compact`, and `/stop`

## Runtime Structure

`index.ts` remains the extension entrypoint and composition root. Reusable runtime logic is split into flat domain files under `/lib` rather than into a deep local module tree.

Architecture shorthand: this repository uses a `Flat Domain DAG`: cohesive bridge domains live as flat `/lib/*.ts` modules, local imports must form a directed acyclic graph, shared buckets are avoided, and `index.ts` wires live pi/Telegram ports plus session state.

Domain grouping rule: prefer cohesive domain files over atomizing every helper into its own file. A `shared` domain is allowed only for types or constants that genuinely span multiple bridge domains.

Interface consistency rule: when two modules mean the same runtime entity, they should converge on the owning domain's exported contract. Local structural `*Like` or view contracts are appropriate only when a domain intentionally needs a narrow projection to avoid unnecessary coupling; they should not become duplicate source-of-truth shapes for the same entity.

Naming rule: because the repository already scopes this codebase to Telegram, extracted module and test filenames use bare domain names such as `api.ts`, `queue.ts`, `updates.ts`, and `queue.test.ts` rather than repeating `telegram-*` in every filename.

Current runtime areas use these ownership boundaries:

| Domain                              | Owns                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                          | Single composition root for live pi/Telegram ports, session state, API-bound transport adapters, and status updates                                               |
| `api`                               | Bot API transport shapes/helpers, retries, file download, temp-dir lifecycle, inbound limits, chat actions, lazy bot-token clients, runtime error recording       |
| `config` / `setup`                  | Persisted bot/session pairing state, authorization, first-user pairing, token prompting, env fallback, validation, config persistence                             |
| `locks` / `polling`                 | Singleton `locks.json` ownership, takeover/restart semantics, long-poll controller state, update offset persistence, poll-loop runtime wiring                     |
| `updates` / `routing`               | Update classification/execution planning, paired authorization, reactions, edits, callbacks, and inbound route composition                                        |
| `media` / `turns` / `attachment-handlers` | Text/media extraction, media-group debounce, inbound downloads, turn building/editing, image reads, attachment-handler matching/execution/fallback output    |
| `queue`                             | Queue item contracts, lane admission/order, stores, mutations, dispatch readiness/runtime, prompt/control enqueueing, session and agent/tool lifecycle sequencing |
| `runtime`                           | Session-local coordination primitives: counters, lifecycle flags, setup guard, abort handler, typing-loop timers, prompt-dispatch flags, agent-end reset binding  |
| `model` / `menu` / `commands`       | Model identity/thinking levels, scoped model resolution, in-flight switching, inline status/model/thinking UI, slash commands, bot command registration           |
| `preview` / `replies` / `rendering` | Preview lifecycle/transports, final reply delivery and reply parameters, Telegram HTML Markdown rendering, chunking, stable-preview snapshots                     |
| `outbound-handlers`                 | Assistant-authored outbound comments, generated reply artifacts, inline-keyboard callbacks, and post-`agent_end` outbound action delivery                         |
| `attachments`                       | `telegram_attach` registration, outbound attachment queueing, stat/limit checks, photo/document delivery classification                                           |
| `status`                            | Status-bar/status-message rendering, queue-lane status views, redacted runtime event ring, grouped pi diagnostics                                                 |
| `lifecycle` / `prompts` / `pi`      | pi hook registration, Telegram-specific before-agent prompt injection, centralized direct pi SDK imports and context adapters                                     |
| `command-templates`                 | Portable shell-free command-template standard helpers, composition expansion, placeholder substitution, and executable resolution                                  |

Boundary invariants:

- Constants and state types live with their owning domains; do not reintroduce shared buckets such as `lib/constants.ts` or `lib/types.ts`
- Domain helpers use narrow structural projections when that avoids importing concrete wire DTOs or broader runtime objects unnecessarily
- Preview appearance stays in `rendering`; preview transport/lifecycle stays in `preview`
- Direct `node:*` file-operation imports stay in owning domains, not in `index.ts`
- `index.ts` uses namespace imports for local bridge domains so orchestration reads as `Queue.*`, `Turns.*`, and `Rendering.*`
- Architecture-invariant tests guard the acyclic import graph, pi SDK centralization, entrypoint purity, runtime-domain isolation, structural leaf-domain isolation, menu/model boundaries, API/config separation, media/update/API separation, and attachment boundary isolation
- Mirrored domain regression coverage lives in `/tests/*.test.ts`; test helpers stay local to the mirrored suite by default, and shared fixture folders are justified only by reuse across multiple domain suites

## Configuration UX

`/telegram-setup` uses a progressive-enhancement flow for the bot token prompt:

1. Show the locally saved token from `~/.pi/agent/telegram.json` when one already exists
2. Otherwise use the first configured environment variable from the supported Telegram token list
3. Fall back to the example placeholder when no real value exists

Because `ctx.ui.input()` only exposes placeholder text, the bridge uses `ctx.ui.editor()` whenever a real default value must appear already filled in. The persisted `telegram.json` config is written with private `0600` permissions because it contains the bot token.

## Runtime Ownership

Telegram bot configuration stays in `~/.pi/agent/telegram.json`; singleton runtime ownership lives separately in `~/.pi/agent/locks.json` under `@llblab/pi-telegram`. `/telegram-connect` acquires or moves that lock before polling starts, and `/telegram-disconnect` stops polling and releases it. Session start may read the existing lock and resume polling when the lock already points at the current `pid`/`cwd`; after a full pi process restart, it may also replace a stale lock from the same `cwd` and resume polling automatically. Session start does not create new ownership from an inactive lock, a live external lock, or a stale lock from another directory. Session replacement suspends polling and ownership watchers without releasing the lock, allowing the next session-start hook in the same `pid`/`cwd` to resume from the existing explicit ownership. When a live external owner exists, `/telegram-connect` asks whether to move singleton ownership to the current pi instance. Active owners poll the lock while running through a snapshotted ownership context, so long-lived timers do not touch stale pi contexts after `/new`; they stop local polling when `locks.json` no longer points at their own `pid`/`cwd`, without deleting the new owner lock. Deleting `locks.json` resets runtime ownership without deleting Telegram configuration.

## Message And Queue Flow

### Inbound Path

1. Telegram updates are polled through `getUpdates`
2. Each update offset is persisted only after the update handler succeeds; repeated handler failures are bounded so one poisoned update cannot stall polling forever
3. The bridge filters to the paired private user
4. Media groups are coalesced into a single Telegram turn when needed
5. Slash command parsing uses only the new message text/caption, while Telegram `reply_to_message` text/caption is injected later as prompt-only `[reply]` context for normal queued turns
6. Files are streamed into `~/.pi/agent/tmp/telegram` with a default 50 MiB size limit, partial-download cleanup on failures, and stale temp cleanup on session start; operators can tune the limit with `PI_TELEGRAM_INBOUND_FILE_MAX_BYTES` or `TELEGRAM_MAX_FILE_SIZE_BYTES`
7. Configured inbound attachment handlers may run on downloaded files by MIME wildcard, Telegram attachment type, or generic match selector; command templates receive safe command-arg substitution for `{file}`/`{mime}`/`{type}`
8. Matching handlers are tried in config order: a non-zero exit records diagnostics and falls back to the next matching handler, while the first successful handler stops the chain
9. Local attachments stay visible under `[attachments] <directory>` with relative file entries, and handler stdout is appended under `[outputs]` before the agent sees the turn; failed handlers omit output while keeping the attachment entry
10. A `PendingTelegramTurn` is created and queued locally
11. Telegram `edited_message` updates are routed separately and update a matching queued turn when the original message has not been dispatched yet
12. The queue dispatcher sends the turn into pi only when dispatch is safe

### Queue Safety Model

The bridge keeps its own Telegram queue and does not rely only on pi's internal pending-message state.

Queued items now use two explicit dimensions:

- `kind`: prompt vs control
- `queueLane`: control vs priority vs default

Admission contract:

| Admission             | Examples                                                     | Queue shape                                                          | Dispatch rank |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- | ------------- |
| Immediate execution   | `/compact`, `/stop`, `/help`, `/start`                       | Does not enter the Telegram queue; `/stop` also clears queued items  | N/A           |
| Control queue         | Model-switch continuation turns and future deferred controls | `queueLane: control`; accepts control items and continuation prompts | 0             |
| Priority prompt queue | A waiting prompt promoted by `👍`                            | `kind: prompt`, `queueLane: priority`                                | 1             |
| Default prompt queue  | Normal Telegram text/media turns                             | `kind: prompt`, `queueLane: default`                                 | 2             |

The command action itself carries its execution mode, and the queue domain exposes lane contracts for admission mode, dispatch rank, and allowed item kinds. Queue append and planning paths validate lane admission so a malformed control/default or other invalid lane pairing fails predictably instead of silently changing priority. This lets synthetic control actions and Telegram prompts share one stable ordering model while still rendering distinctly in status output. In the pi status bar, busy labels distinguish `active`, `dispatching`, `queued`, `tool running`, `model`, and `compacting`; priority prompts are marked with `⬆` while control items keep markers such as `⚡`.

A dispatched prompt remains in the queue until `agent_start` consumes it. That keeps the active Telegram turn bound correctly for previews, attachments, abort handling, and final reply delivery.

Dispatch is gated by:

- No active Telegram turn
- No pending Telegram dispatch already sent to pi
- No compaction in progress
- `ctx.isIdle()` being true
- `ctx.hasPendingMessages()` being false

This prevents queue races around rapid follow-ups, `/compact`, and mixed local plus Telegram activity. Post-agent-end dispatch retries are scheduled through a session-bound deferred dispatcher that activates on session start, cancels timers on session shutdown, and skips callbacks from older generations before they touch `ExtensionContext`. Telegram `/status` and `/model` execute immediately; the dispatch controller still serializes any deferred control items so a queued control action must settle before the next queued action can dispatch.

### Abort Behavior

When `/stop` runs from Telegram, it clears pending model-switch state, clears every waiting Telegram queue item, resets aborted-turn history preservation, and then aborts the active Telegram turn when an abort handler exists. This intentionally favors recovery over preservation: priority/default/control queue items are dropped so the next Telegram message can enter a clean queue and dispatch like a fresh TUI prompt after an interrupted run.

## Rendering Model

Telegram replies are rendered as Telegram HTML rather than raw Markdown.

Key rules:

- Rich text should render cleanly in Telegram chats
- Real code blocks must remain literal and escaped
- Supported absolute HTTP(S) and mailto links should stay clickable, with generated HTML attributes escaped separately from text content, while unsupported link forms such as unresolved references, footnotes, or relative links without a known base should degrade safely instead of producing broken Telegram anchors
- Markdown tables should keep their internal separators but drop the outer left and right borders when rendered as monospace blocks so narrow Telegram clients keep more usable width; table padding should count grapheme/display width for multi-codepoint emoji, combining marks, and wide Unicode where possible, and the Telegram before-agent prompt suffix also asks the assistant to prefer narrow table columns because many chats are read on phone-width screens
- Unordered Markdown lists should render with a monospace `-` marker and ordered Markdown lists should render with monospace numeric markers so list indentation stays more predictable on narrow Telegram clients
- Real Markdown task-list items should render with checkbox markers, while standalone `[x]` and `[ ]` prose should stay literal instead of being reinterpreted as checklists
- Nested Markdown quotes should flatten into one Telegram blockquote with added non-breaking-space indentation because Telegram does not render nested blockquotes reliably
- Original blank-line spacing between Markdown blocks should stay intact in both preview and final rendering instead of being collapsed to one generic block separator, while headings should still keep readable separation from following blocks such as code fences even when source Markdown omits a blank line
- Long replies, including raw HTML-mode replies used by interactive/status flows, must be split below Telegram's 4096-character limit
- Raw HTML chunking lives with the rendering helpers in `/lib/rendering.ts` and should preserve/reopen active tags across chunk boundaries where possible
- Preview rendering uses stable top-level Markdown blocks for rich Telegram HTML and appends the still-growing tail conservatively as readable plain text so the preview stays valid even when the answer is incomplete

The renderer is a Telegram-specific formatter, not a general Markdown engine, so rendering changes should be treated as regression-prone.

## Streaming And Delivery

During generation, the bridge streams previews back to Telegram.

Preferred order:

1. Re-render the current Markdown buffer into a preview snapshot that renders closed top-level blocks as rich Telegram HTML and keeps the unstable tail conservative and readable
2. Send or update that preview through `sendMessage` plus `editMessageText`, because `sendMessageDraft` is text-only for rich previews
3. Serialize overlapping preview flushes so older Telegram edit calls cannot race newer streamed snapshots
4. Replace the preview with the final rendered reply when generation ends

Draft streaming can remain as a plain-text fallback path, but rich Telegram previews are driven through editable messages and stable-block snapshot selection.

Telegram prompt responses use explicit delivery context to attach outbound text, rich previews, errors, attachment notices, and uploads as Telegram replies to the source prompt when possible. Reply metadata is opt-in per delivery path, uses `reply_parameters` with `allow_sending_without_reply: true`, and is applied only to the first chunk of split long responses; continuation chunks are sent as normal adjacent messages. Media-group turns reply to the turn's representative `replyToMessageId`, not to every source message in the group.

Outbound files are sent only after the active Telegram turn completes, must be staged through the `telegram_attach` tool, are staged atomically per tool call, are checked against a default 50 MiB limit configurable through `PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES` or `TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES`, and use file-backed multipart blobs so large sends do not require preloading whole files into memory.

Assistant-authored outbound actions use final-message markup instead of agent tool calls. Preview updates strip closed top-level HTML comments and currently open/partial top-level comment starts before rendering, so users do not see transient metadata even when streaming flushes happen after only `<`, `<!`, or `<!--`. On `agent_end`, the bridge removes top-level comments from the Markdown text reply, but treats column-zero top-level `<!-- telegram_voice ... -->` and `<!-- telegram_button ... -->` blocks specially before delivery; comments inside fenced code, quotes, lists, or indented examples stay literal, including fenced blocks with Markdown-valid indented closing fences. Voice maps to the first matching `outboundHandlers[]` entry with `type: "voice"`, synthesizes the block body through command-template execution, and uploads the generated OGG/Opus file via Telegram `sendVoice`; when no outbound voice handler is configured, it silently skips voice delivery. The `template: [...]` form can express TTS plus MP3-to-OGG conversion using configured templates and bridge-provided `{text}`, `{mp3}`, and `{ogg}` placeholders. Top-level `args` and `defaults` apply to all composed steps unless a step defines private values, top-level `timeout` wraps the whole sequence, and each step receives the previous step's stdout on stdin by default, without hard-coded filesystem defaults. Button blocks are built in: each `telegram_button` block becomes one inline-keyboard button on the final text, and callback clicks enqueue the configured prompt text, or the button label when the body is omitted, as a normal Telegram prompt turn. This keeps technical Markdown, code, tables, formulas, and numbered lists in the text channel when appropriate while allowing TTS-friendly voice messages and tappable continuations without invoking `telegram_attach` or extra transport tools.

## Interactive Controls

The bridge exposes Telegram-side session controls in addition to regular chat forwarding.

Current operator controls include:

- `/status` for model, usage, cost, and context visibility, executed immediately from Telegram even while generation is active
- Inline status buttons for model and thinking adjustments, applying idle selections immediately while still respecting busy-run restart rules; model-menu inputs are cached briefly and stored inline-menu states are pruned by TTL/LRU so old keyboards expire predictably
- `/model` for interactive model selection, executed immediately from Telegram and supporting in-flight restart of the active Telegram-owned run on a newly selected model
- `/compact` for Telegram-triggered pi session compaction when the bridge is idle
- `/stop` for aborting the active Telegram-owned run and clearing waiting Telegram queue items
- `/telegram-status` for pi-side diagnostics as grouped line-by-line sections separated by blank lines: connection, polling, execution, queue, and the recent redacted runtime/API event ring. These sections include polling state, last update id, active turn source ids, pending dispatch, compaction state, active tool count, pending model-switch state, total queue depth, and queue-lane counts. The event ring records transport/API, polling/update, prompt-dispatch, control-action, typing, compaction, setup, session-lifecycle, and attachment queue/delivery failures; benign unchanged edit responses and unsupported empty draft-clear attempts are filtered out so expected preview transport noise does not obscure real failures
- Queue reactions using `👍` and `👎` apply to waiting text, voice, file, image, and media-group turns by matching the turn's source Telegram message ids; `👎` acts as the canonical queue-removal path because ordinary Telegram DM message deletions are not exposed through the Bot API polling path this bridge uses

## In-Flight Model Switching

When `/model` is used during an active Telegram-owned run, the bridge can emulate the interactive pi workflow of stopping, switching model, and continuing.

The current implementation does this by:

1. Applying the newly selected model immediately
2. Queuing or staging a synthetic Telegram continuation turn
3. Aborting the active Telegram turn immediately, or delaying the abort until the current tool finishes when a tool call is in flight
4. Dispatching the continuation turn after the abort completes

This behavior is intentionally limited to runs currently owned by the Telegram bridge. If pi is busy with non-Telegram work, the bridge still refuses the switch instead of hijacking unrelated session activity.

## Related

- [README.md](../README.md)
- [Project Context](../AGENTS.md)
- [Project Backlog](../BACKLOG.md)
- [Changelog](../CHANGELOG.md)
