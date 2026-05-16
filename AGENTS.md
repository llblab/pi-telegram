# Project Context

## 0. Meta-Protocol Principles

- `Constraint-Driven Evolution`: Add structure when the bridge gains real operator or runtime constraints
- `Single Source of Truth`: Keep durable rules in `AGENTS.md`, open work in `BACKLOG.md`, completed delivery in `CHANGELOG.md`, and deeper technical detail in `/docs`
- `Boundary Clarity`: Separate Telegram transport concerns, π integration concerns, rendering behavior, and release/documentation state
- `Progressive Enhancement + Graceful Degradation`: Prefer behavior that upgrades automatically when richer runtime context exists, but always preserves a useful fallback path when it does not
- `Runtime Safety`: Prefer queue and rendering behavior that fails predictably over clever behavior that can desynchronize the Telegram bridge from π session state
- `Pi-Native Extensibility`: `pi-telegram` should inherit π's own extension philosophy. It is not only a Telegram adapter; it should become a small, convenient, composable Telegram shell for π extensions, where new capabilities plug into stable contracts instead of forking polling, transport, or menu ownership.

## 1. Concept

`pi-telegram` is a Telegram runtime adapter for π: a session-local operator console that turns a private Telegram DM into a runtime surface for prompt intake, streaming previews, queue management, model/thinking/settings controls, inbound/outbound handler pipelines, voice/buttons, artifacts, and extension callback interop. Treat it as a Telegram membrane around π, not a narrow message pipe.

## 2. Identity & Naming Contract

- `Telegram turn`: One unit of Telegram input processed by π; this may represent one message or a coalesced media group
- `Queued Telegram turn`: A Telegram turn accepted by the bridge but not yet active in π
- `Active Telegram turn`: The Telegram turn currently bound to the running π agent loop
- `Preview`: The transient streamed response shown through Telegram drafts or editable messages before the final reply lands
- `Scoped models`: The subset of models exposed to Telegram model selection when π settings or CLI flags limit the available list

## 3. Project Topology

- `/index.ts`: Main extension entrypoint and runtime composition layer for the bridge
- `/lib/*.ts`: Flat domain modules for reusable runtime logic. Favor domain files such as queueing/runtime, replies, polling, updates, outbound-attachments, commands, lifecycle hooks, prompts, prompt-templates, pi SDK adapter, Telegram API, config, turns, media, setup, rendering, app menu, menu-model, menu-thinking, menu-queue, status/model-resolution support, and other cohesive bridge subsystems; use `shared` only when a type or constant truly spans multiple domains
- `/tests/*.test.ts`: Domain-mirrored regression suites that follow the same flat naming as `/lib`
- `/docs/README.md`: Documentation index for technical project docs
- `/docs/architecture.md`: Runtime and subsystem overview for the bridge
- `/README.md`: User-facing project entry point. Keep its rhythm as install → connect → use → core features → docs, with vivid examples that explain the runtime adapter/operator-console model without duplicating full docs.
- `/AGENTS.md`: Durable engineering and runtime conventions
- `/BACKLOG.md`: Canonical open work
- `/CHANGELOG.md`: Completed delivery history

## 4. Core Entities

- `TelegramConfig`: Persisted bot/session pairing state
- `PendingTelegramTurn`: Queue-domain prompt turn state for queued and active Telegram-originated work
- `TelegramPreviewRuntimeState`: Preview-domain streaming state for drafts or editable Telegram messages
- `TelegramModelMenuState`: Shared inline application-menu state for status, model, thinking, and queue menu messages
- `QueuedAttachment`: Outbound files staged for delivery through `telegram_attach`

## 5. Architectural Decisions

## 5.1 Flat Domain DAG Shape

- The project follows a `Flat Domain DAG`: cohesive bridge domains live as flat `/lib/*.ts` modules, and local imports must form a directed acyclic graph
- `index.ts` stays the single extension entrypoint and composition root for live π/Telegram ports, SDK adapters, and session state
- Reusable runtime logic should be split into flat domain files under `/lib`
- Opening source-module comments must include `Zones:` tags such as `telegram`, `pi agent`, `tui`, or `shared utils`; these tags replace folder nesting as the quick responsibility map for flat Domain DAG files
- Prefer domain-oriented grouping over atomizing every helper into its own file
- Use `shared` sparingly and only for types or constants that genuinely span multiple bridge domains

## 5.2 Session And Queue Semantics

- The bridge is session-local, paired to one allowed Telegram user, and owns a local queue aligned with π lifecycle hooks
- Queue admission is explicit and validated: immediate commands, control lane, priority lane, and default lane must preserve allowed kind/lane pairings
- Dispatch is gated by active turns, pending dispatch, unsettled control work, compaction, `ctx.isIdle()`, and π pending messages; dispatched prompts remain queued until `agent_start` consumes them
- Telegram `/compact` owns a native `typing` keepalive for the compaction window so phone clients show activity between the started/completed notices; stop it on both completion and failure
- `/stop`, `/abort`, `/next`, and `/continue` have distinct contracts: reset queue and abort; abort while preserving queue; force next queued turn; enqueue a priority `continue` prompt
- `/start`, `/help`, and `/status` open the unified command-help/status-row/control menu; `/model`, `/thinking`, and `/queue` jump to sections directly; visible bot commands are `/start`, `/compact`, `/next`, `/continue`, `/abort`, `/stop`
- Command/menu emoji are fixed UI adornments owned by the `commands` map; do not add a persisted emoji toggle or Settings menu until there is a real setting to own
- Telegram `reply_to_message` context is prompt-only and must not affect slash-command parsing
- Long-lived timers, pollers, watchers, and deferred queue dispatch must be session-bound and avoid stale live π contexts after session replacement
- In-flight `/model` switching is limited to Telegram-owned active turns; if a tool call is active, abort is delayed until the tool finishes

## 5.3 Telegram Delivery Semantics

- Telegram replies render through Telegram HTML, not raw Markdown
- Real code blocks must stay literal and escaped
- `telegram_attach` is the canonical outbound file-delivery path for Telegram-originated requests
- Telegram delivery strips top-level HTML comments from preview/final text; column-zero top-level `<!-- telegram_voice ... -->` and `<!-- telegram_button ... -->` blocks are special outbound comments handled after `agent_end` without requiring agent-side transport tool calls, while comments inside code, quotes, lists, or indented examples stay literal
- `telegram_voice` and `telegram_button` are not π tools; keep prompts/docs explicit that agents should author markup while the extension owns command-template voice pipelines, button routing, and Telegram delivery
- `telegram_voice` text is arbitrary TTS-target text: use body form for multiline text, `<!-- telegram_voice text="Short summary" -->` for explicit one-line text, or `<!-- telegram_voice: Short summary -->` for one-line text with no attributes
- `telegram_button` has three canonical forms: `<!-- telegram_button: OK -->` for label-only buttons, `<!-- telegram_button label=Continue prompt="Continue with the current plan." -->` for one-line prompts, or `<!-- telegram_button label="Show risks"\nList the main risks first.\n-->` for multiline prompts

## 6. Engineering Conventions

## 6.1 Validation Hotspots

- Treat queue handling, compaction interaction, and lifecycle-hook state transitions as regression-prone areas; validate them after changing dispatch logic
- Route important runtime failures through the recent runtime event recorder so `/telegram-status` remains useful for post-mortem debugging, not just transient status-bar errors
- Treat Markdown rendering as Telegram-specific output work, not generic Markdown rendering
- Preserve literal code content in Telegram rendering
- Avoid HTML chunk splits that break tags
- Prefer width-efficient monospace table and list formatting for narrow clients, with table padding based on grapheme/display width rather than raw UTF-16 length where possible
- Flatten nested Markdown quotes into indented single-blockquote output because Telegram does not render nested blockquotes reliably

## 6.2 File And Naming Style

- Keep comments and user-facing docs in English unless the surrounding file already follows another convention
- Each project `.ts` file should start with a short multi-line responsibility header comment that explains the file boundary to future maintainers; source-module headers must include `Zones:` tags for cross-cutting responsibility areas
- Name extracted `/lib` modules and mirrored `/tests` suites by bare domain when the repository already supplies the Telegram scope; prefer `api.ts`, `queue.ts`, `updates.ts`, and `queue.test.ts` over redundant `telegram-*` filename prefixes
- Keep test helpers with the mirrored domain suite by default because test files mirror module-domain boundaries; introduce shared `tests/fixtures` only when multiple domain suites truly reuse the same setup
- Prefer targeted edits, keeping `index.ts` as the orchestration layer and moving reusable logic into flat `/lib` domain modules when a subsystem becomes large enough to earn extraction
- Keep composition wiring DRY with small local adapters or owning-domain contracts when repetition appears, but do not hide live mutable session state behind broad facades just to reduce repeated closures
- Keep interface contracts consistent for the same runtime entity: prefer the owning domain's exported contract when multiple modules mean the same entity, and use local structural `*Like`/view contracts only for deliberate narrow projections that avoid real coupling without duplicating source-of-truth shapes

## 6.3 Current Domain Ownership Snapshot

The canonical detailed ownership map lives in [`docs/architecture.md`](./docs/architecture.md). Keep this section as a compact agent-facing index, not a second copy of the full map.

- Scheduling and lifecycle: `queue`, `runtime`, `lifecycle`, `locks`
- Telegram transport and inbound flow: `api`, `polling`, `updates`, `routing`, `media`, `turns`, `inbound-handlers`, `config`, `setup`
- Response surfaces: `preview`, `replies`, `rendering`, `keyboard`, `outbound-attachments`, `outbound-handlers`, `status`
- Controls and application menu UI: `commands`, `menu`, `menu-model`, `menu-thinking`, `menu-status`, `menu-queue`, `model`, `prompts`
- Extension platform: `extension-sections` owns section registry, token mapping, callback dispatch, context building, and globalThis bridge
- Pi SDK boundary: `pi` owns direct pi imports and bound extension API ports

## 6.4 Entrypoint And Import Boundaries

- Keep preview appearance logic in the rendering domain and preview transport/lifecycle logic in the preview domain so richer streaming strategies can evolve without entangling Telegram delivery state with Markdown formatting rules
- Keep direct `node:*` file-operation dependencies out of `index.ts` when an owning domain exists; the entrypoint should compose ports while domains own local filesystem details such as temp-dir preparation, attachment stats, and turn image reads
- In `index.ts`, prefer namespace imports for local bridge domains so orchestration reads as domain-scoped calls such as `Queue.*`, `Turns.*`, and `Rendering.*` instead of long flat import lists
- Keep the local `index.ts` plus `/lib/*.ts` import graph acyclic; `tests/invariants.test.ts` guards this boundary plus shared-bucket bans, empty interface-extension shell regressions, pi SDK centralization, source-only entrypoint Node-runtime/local-adapter/process/direct-pi access avoidance, runtime-domain isolation, structural leaf-domain import isolation, menu/model boundary drift, API/config default coupling, structural update/media coupling to API transport shapes, and attachment coupling to queue/inbound media/API helpers as domains keep evolving
- Do not reintroduce shared bucket domains such as `lib/constants.ts` or `lib/types.ts`; constants, state interfaces, and concrete transport shapes should stay in their owning domains, and `index.ts` should not grow new shared magic constants
- Keep remaining `index.ts` code focused on cross-domain adapter wiring that needs live extension state, pi callbacks, Telegram API ports, or status updates; do not extract one-off closures solely to reduce line count
- Domain-specific queue planning, preview transport/controller behavior, rendering, Telegram API transport, menu state, and command behavior should stay in their owning domains instead of moving to `/lib/runtime.ts` solely to shrink `index.ts`
- Prefer narrow structural runtime ports in domains that only store or route pi-compatible values; direct pi SDK/model imports should stay centralized in `/lib/pi.ts`, while domains that actively register pi hooks/tools/commands should consume those concrete contracts through the adapter

## 7. Operational Conventions

- When Telegram-visible behavior changes, sync `README.md` and the relevant `/docs` entry in the same pass
- When durable runtime constraints or repeat bug patterns emerge, record them here instead of burying them in changelog prose
- When fork identity changes, keep `README.md`, package metadata, and docs aligned so the published package does not point back at stale upstream coordinates
- README positioning should emphasize `/start` as the primary Telegram operator menu and keep reaction shortcuts secondary. Reactions are useful queue affordances, but menu controls are the core CLI-to-Telegram bridge.
- Document configuration knobs without UI in the root README when they affect bootstrap, networking, or transport limits; currently this includes token env bootstrap, Node env proxy mode, and inbound/outbound size limits.
- Work only inside this repository during development tasks; updating the installed Pi extension checkout is a separate manual operator step, not part of normal in-repo implementation work

## 8. Integration Protocols

- Telegram API methods currently used include polling, message editing, draft streaming, callback queries, reactions, file download, and media upload endpoints
- π integration depends on lifecycle hooks such as `before_agent_start`, `agent_start`, `message_start`, `message_update`, and `agent_end`
- `ctx.ui.input()` provides placeholder text rather than an editable prefilled value; when a real default must appear already filled in, prefer `ctx.ui.editor()`
- For `/telegram-setup`, prefer the locally saved bot token over environment variables on repeat setup runs; env vars are the bootstrap path when no local token exists, and persisted `telegram.json` writes must remain atomic plus private because status/setup/polling paths may read it concurrently
- Command help plus prompt-template commands and status/model/thinking/queue controls are driven through `/start`'s Telegram inline application menu and callback queries; the Queue button shows the queued-item count, model-menu scope/pagination controls stay at the top under Main menu, the model pagination indicator opens a compact page picker, and thinking-menu text stays a compact heading because the current level is marked by button state; `/status`, `/model`, `/thinking`, and `/queue` are hidden compatibility shortcuts
- Shared inline-keyboard structure belongs to `keyboard`; application-control button labels, callback data, and callback behavior stay in `menu`/`menu-model`/`menu-thinking`/`menu-status`/`menu-queue` while core queue mechanics stay in `queue`
- Telegram `/settings` options should open nested detail submenus by default: checkbox options show a description plus Back, On, and Off; list options show Back plus selectable values. One-shot actions such as syncing may run directly without a submenu when there is no meaningful choice or description step.
- Inbound text/media may be transformed through configured `inboundHandlers` before queueing; legacy `attachmentHandlers` are deprecated compatibility aliases appended after `inboundHandlers`; outbound files must flow through `telegram_attach`
- Long Telegram text split recovery belongs to `text-groups`: keep it conservative, short-debounced, same chat/user/message-id contiguous, and gated by near-limit human text so normal rapid follow-ups and slash commands stay separate
- Inbound handlers and command-backed outbound handlers use command templates as the standard integration contract; built-in outbound buttons use inline keyboards plus callback routing because no external command execution is needed
- Telegram prompt-template commands are discovered from π slash commands with `source: "prompt"`; π template names are mapped to Bot API-compatible aliases (`fix-tests` → `/fix_tests`), aliases that conflict with built-in bridge commands or hidden shortcuts are not displayed, prompt-template aliases stay out of the Telegram bot command menu, and the bridge expands template files before queueing because extension-originated `sendUserMessage()` bypasses π's interactive template expansion
- Unknown callback data not owned by pi-telegram prefixes (`tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `section:`, `settings:`) may be forwarded as `[callback] <data>` after built-in handlers decline it; external extensions should follow `docs/callback-namespaces.md` and must not poll the same bot independently
- Command templates stay compact and shell-free: no `command` field, no shell execution, inline defaults are allowed as `{name=default}`, `template` may be a string or an ordered composition array, only `args`/`defaults` inherit into leaves, top-level `timeout` wraps composed sequences, stdout pipes to the next step's stdin by default, and multi-step work should use `template: [...]` rather than provider-specific fields; `pipe` is only a legacy local alias
- Command-template documentation examples should use portable executable placeholders such as `/path/to/stt` and `/path/to/tts`, not host-local skill paths or machine-specific install locations

## 9. Extension Sections Conventions

- `Section identity`: use the same identity-key rules as the Extension Locks Standard (`package.json/name` → canonical id); no separate `owner` field
- `Token mapping`: Telegram's 64-byte `callback_data` limit forces compact numeric tokens (`section:0:action:payload`). Section authors never hand-roll `section:` strings — use `ctx.callbackData(action, payload?)`
- `Navigation hierarchy`: Back buttons are auto-prepended by `ctx.edit()` / `ctx.open()`. Root views use `⬆️ Main menu` → `menu:back`. Nested views from `handleCallback` use `⬆️ Back` → `section:<token>:open`. Settings views use `⬆️ Back` → `settings:list`
- `Context ports`: sections receive `TelegramSectionContext` / `TelegramSectionCallbackContext` with `answerCallback`, `edit`, `open`, `enqueuePrompt`, and `callbackData`. No filesystem access, no raw bot clients, no second poller
- `Settings indicators`: use `settings.getLabel()` for dynamic status rows in the Settings submenu (e.g., `🟢`/`⚫️` based on internal state). Called on every Settings list render
- `Handler fallback`: `section.handleCallback` runs first; if it returns `"pass"` and `settings.handleCallback` exists, the settings handler runs with a fresh context carrying `backCallback="settings:list"`
- `Stale tokens`: unknown or unregistered tokens answer the callback with a short popup. Section errors are caught and surfaced as popup text — no unhandled exceptions leak to the poller
- `Load order`: `pi-telegram` must load first (sets `globalThis.__piTelegramSectionRegistry__`). Consumer extensions load second. The typed import is the preferred path; the `globalThis` bridge exists for load-order tolerance
- `Shutdown`: call `pi.on("shutdown", () => unregister())` in the extension's default export
- `Section separators`: extension-injected main-menu rows appear before the **⚙️ Settings** row. Extension settings rows appear before built-in Proactive push controls
- `Model button format`: use `provider/ModelId` format (e.g., `anthropic/claude-sonnet-4-5`) across model menu buttons and status row. The compact `provider/id` form is canonical
- `Section domain ownership`: `lib/extension-sections.ts` owns the registry, token mapping, callback dispatch, and context building. `lib/menu.ts` dispatches `section:` callbacks before built-in handling. `lib/menu-status.ts` injects section rows. `lib/menu-settings.ts` injects settings rows and passes `sectionRegistry` through callback deps
- `Callback routing order`: button actions → queue menu → settings menu → section callbacks → built-in menu handling → `[callback]` fallback. Settings menu callbacks always pass `sectionRegistry` to `updateTelegramSettingsMenuMessage` and `handleTelegramSettingsMenuCallbackAction`

## 9. Pre-Task Preparation Protocol

- Read `README.md` for current user-facing behavior and fork positioning
- Read `BACKLOG.md` before changing runtime behavior or documentation so open work stays truthful
- Read `/docs/architecture.md` before restructuring queue, preview, rendering, or command-handling logic
- Inspect the relevant `index.ts` section before editing because most bridge behavior is stateful and cross-linked

## 10. Task Completion Protocol

- Run the smallest meaningful validation for the touched area; `npm test` is the default regression suite once rendering or queue logic changes
- For rendering changes, ensure regressions still cover nested lists, code blocks, underscore-heavy text, and long-message chunking
- For queue/dispatch changes, validate abort, compaction, pending-dispatch, and π pending-message guard behavior
- Sync `README.md`, `CHANGELOG.md`, `BACKLOG.md`, and `/docs` whenever user-visible behavior or real open-work state changes
