# Public API

`pi-telegram` is both a Pi extension and a small Telegram platform for companion extensions. This document defines the stable public surface. Everything outside this document is implementation detail unless another focused doc explicitly marks it stable.

## Stability Levels

- **Stable:** documented here and covered by compatibility expectations.
- **Advanced stable:** public for extension authors, but lower-level; prefer higher-level APIs when possible.
- **Compatibility:** older import/config paths that remain supported but should not be used for new code.
- **Internal:** exported from source for tests or domain reuse, but not a compatibility promise.

The 0.21 Activity surface requires Pi `0.80.6` or newer. This minimum belongs to the package peer contract because `agent_settled` provides the only safe terminal boundary after retries, compaction, and queued continuations.

## Package Entrypoints

Preferred public imports:

```ts
import telegram from "@llblab/pi-telegram";
import { registerTelegramSection } from "@llblab/pi-telegram/sections";
import { registerTelegramStatusLineProvider } from "@llblab/pi-telegram/status";
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";
import { registerTelegramCommand } from "@llblab/pi-telegram/commands";
import { registerTelegramInboundHandler } from "@llblab/pi-telegram/inbound";
import { registerTelegramOutboundHandler } from "@llblab/pi-telegram/outbound";
import { sendTelegramView } from "@llblab/pi-telegram/delivery";
import { registerTelegramActivityHandler } from "@llblab/pi-telegram/activity";
import {
  registerTelegramVoiceSynthesisProvider,
  registerTelegramVoiceTranscriptionProvider,
} from "@llblab/pi-telegram/voice";
```

`0.12.0` intentionally removes the published `@llblab/pi-telegram/lib/*.ts` compatibility wildcard. Integrations should use the public API domain subpaths above. Package exports point at `/api/*.ts` membranes that re-export only stable companion-extension symbols; implementation modules under `lib/` remain package-private. Telegram command extensions use `/commands` as an explicit opt-in surface instead of automatically exposing arbitrary Pi slash commands to Telegram. See [Public API Smoke Examples](#public-api-smoke-examples) below for minimal companion-extension patterns that avoid implementation imports.

## User-Facing API

### Pi commands

Stable commands inside Pi:

- `/telegram-setup` — configure/update the bot token.
- `/telegram-connect` — start polling here and acquire external Telegram control ownership, optionally for a named profile. Thread names are configured from Telegram rather than Pi commands. Accepted queue/reply state stays local if ownership later moves elsewhere. A successful command queues a hidden connection-state note for delivery with the agent's next turn without triggering one; it says Telegram is connected and that connectivity alone is not user intent. An immediate local `/resume` carries pending connection intent and the selected profile to the destination session without carrying the source Thread; its own binding is restored or allocated through normal authority checks. Connection failures produce one compact cause/action notice instead of rethrowing raw exception text into Pi; redacted technical evidence remains available through `/telegram-status --debug`.
- `/telegram-disconnect` — after destructive confirmation, stop polling and release ownership without deleting or silencing accepted local queue state. A successful command queues the corresponding hidden, non-triggering disconnected context note; cancelled or failed disconnects do not publish a false state transition. In Threaded Mode it deletes this instance's current Telegram thread; a follower waits for its active leader to confirm generation-fenced cleanup before stopping. Graceful Pi `quit` performs the same teardown without prompting, while session replacement suspends transport without disconnect teardown. Local `/resume` carries connection intent rather than the source Thread; other supported replacements retain their existing continuity rules.
- `/telegram-status` — show connection, polling, execution, queue, and recent event diagnostics; debug output separates poller and worker progress, durable automatic-retry state, exact foreign queued-owner identity, and negotiated protocol/build/capabilities.

The `/telegram-connect --internal new <token>` form is a runtime-only dispatch, not a profile connection or a manual new-session shortcut. It requires the exact prepared one-use action and bypasses profile activation, connection intents and startup/recovery. Missing, forged, replayed, unsupported or malformed internal calls fail closed; invalid calls do not consume a valid pending action. The flag is reserved, but `internal` without the leading dashes remains a valid profile name. The standalone `/telegram-internal` command is no longer registered.

### Telegram commands

- `/name Name` — set the durable manual display name of the current Thread. The routed leader or follower uses the authenticated target-fenced mutation and edits the visible title over the active automatic projection. Bare `/name` immediately opens expiring exact-target input; the next valid name is consumed before agent dispatch. Cancel is always available; **Reset to automatic** appears only when a manual name exists. Entering a bare uppercase slot letter such as `A` is also treated as an explicit reset to the current automatic display projection rather than as a manual name.

Stable commands inside the paired Telegram DM:

- `/start` — pair when needed and open the main application menu.
- `/new` — after idle and empty-queue checks, request a new Pi session in the current classic chat or Thread. The bridge acknowledges the callback, deletes its confirmation, completes and removes the exact durable update, then dispatches one runtime-armed typed action through the internal `/telegram-connect --internal new <token>` Pi gateway using `pi.sendUserMessage(..., { expandPromptTemplates: true })`. Manual invocation reports that the gateway cannot be run manually; the armed handler receives a real `ExtensionCommandContext` and calls `ctx.newSession()`; one discriminated durable intent preserves either exact classic Profile/CWD/session/chat continuity or the Thread binding with slot/name re-key. The successor CAS-claims that intent before sending one terminal result. In a follower Thread the leader publishes and claims the intent on the follower's behalf over capability-gated, exact-generation local bus requests; followers never persist leader-owned state. Busy, identity-mismatch, stale-registration, incompatible-leader, and unavailable-host paths fail closed.
- `/compact` — open confirmation and compact when idle.
- `/next` — abort active work first when needed, attempt the interrupted prompt's abort notice, then reply `Dispatching next queued turn.` to the exact queued prompt selected for the next model turn. That dispatch notice owns the turn's one reply header; later answer messages do not reply to the same prompt again. Abort-notice failure is diagnostic and cannot block dispatch. A later `/abort` or `/stop` cancels both pending transition notices before taking ownership. The `/next` command itself is never the lifecycle-notice reply target, and aborted pending assistant text is suppressed.
- `/continue` — enqueue a priority `continue` prompt.
- `/abort` — abort active work and keep the queue; abort-history is scoped to Telegram-owned active turns.
- `/stop` — abort active Telegram-owned work and clear waiting Telegram queue items.

The hidden emergency command `/quit` is accepted when typed but omitted from bot menus, suggestions and ordinary help. It opens **Quit this Pi instance?** with **🚪 Yes, quit** / **❌ No** through the shared Confirm API. Only the paired owner can confirm the exact current instance dialog. After feedback and positive removal of that callback update from its original journal namespace, the instance requests active-work cancellation and orderly public-SDK shutdown. It does not wait for idle or enqueue a model turn; new Telegram dispatch is fenced as soon as confirmed quit is scheduled. Waiting items are not discarded early: the existing graceful session-shutdown policy then disposes remaining queue authority before clearing memory. No session history/project files are deleted, no other process or process group is killed, and the existing on-quit Thread policy remains authoritative. A fully blocked event loop, uncooperative cancellation or an external auto-restarting supervisor may prevent a lasting exit; there is no force-kill fallback. This is unreleased local implementation, not live acceptance.

Hidden compatibility shortcuts may open sections directly: `/help`, `/status`, `/model`, `/thinking`, `/queue`, and `/settings`.

**Command discovery:** After built-ins, companion commands and prompt templates decline a plain text message, a lone `/` replies with the full public catalogue: every built-in including the shortcuts above, all registered companion commands whether or not they appear in the bot menu, and prompt-template commands. A Telegram bot-command-shaped token (`/` plus letters, digits or underscores) that is not a built-in, companion command, prompt template or Pi command gets the same catalogue headed by an unknown-command notice and is not queued. Hidden `/quit`, internal gateways and Pi-only host commands are never listed. Paths, `/skill:name`, hyphenated names, prose starting with a slash, captions and media groups keep the ordinary prompt path. The catalogue has three blank-line-separated blocks: actual bot-menu entries in native menu order, the remaining public commands alphabetically, then prompt-template commands alphabetically. Menu membership uses the same native registration policy, including visible companion commands that have descriptions. Empty blocks are omitted. The catalogue is bounded to one Telegram message; this is local implementation, not live client acceptance.

This command surface is a mobile companion subset, not a raw terminal-command bridge or session browser. A Telegram destination follows its assigned Pi instance and sends prompts into that instance's currently active session; it is not permanently bound to one session identity. Compaction and new-session replacement operate on the current session; resume, fork, tree navigation, session switching, TUI transcript clearing, and arbitrary slash-command dispatch stay out of the stable Telegram API unless Pi exposes safe public extension hooks for them.

An unbound Thread chooser offers **⛔️ Cancel routing** to the current paired owner for any input it routes: text, commands, any attachment kind and albums alike. The only condition is that every source supports exact private retention. It retains the original privately without sending it to Pi or deleting its Telegram message/Thread. This is not `/abort` or `/stop`: already selected, partially forwarded, queued or running work cannot be cancelled here. Failed cancellation or chooser updates retain the same button for exact retry. When the current leader has protected attempts, **Status → ❌ Pending cancellations** opens owner-only review with up to five supported inputs per page. Finish cancellation preserves the original and starts no new delivery; previously accepted work may continue. Refresh, navigation, reload and ownership changes invalidate old controls. Corrupt retention evidence stays protected without implicit repair. After a restart, an input still waiting for its choice gets its original chooser back, with working buttons and the same deadline, while its tab is unbound; inputs whose choice was already made stay protected until their deadline. Existing retained attempts remain recoverable. Historical unbound startup text is still held before default routing, but the Historical inputs menu entry and its review/Stop retrying submenu are removed. Previously published historical callbacks are answered as unavailable; they neither reopen the view nor authorize routing or abandonment. Hiding this technical state does not establish non-delivery or cancel independently accepted work. Confirmed eligible unbound prompt choosers now retain a fixed 60-minute deadline from first positive publication acknowledgement; refresh/restart does not renew it. Validated selection freezes expiry before effects; browsing or unavailable targets does not. Expiry retains the exact unselected original privately before pending-journal removal and invalidates stale controls, without Thread deletion, Pi stop or task-completion reporting. Selected/accepted/uncertain work and historical or unconfirmed clocks remain protected; no tab-disappearance signal is required. The journal lifetime capability and carrier hooks are package-private, not a new companion API. Live acceptance passed in the operator's 0.52.0 live smoke.

### Tools and assistant-authored actions

Every assistant-authored HTML comment is transport-private on Telegram: previews and final replies remove `<!-- … -->` blocks regardless of Markdown nesting or which extension owns the comment, and complete recognized comments activate voice or buttons independently of surrounding whitespace or Markdown, including code fences. Escape the opening delimiter as `&lt;!--` for literal examples. Unclosed comment tails are withheld and a comment-only result sends no text message; Pi's terminal transcript remains unchanged.

- `telegram_bind({ app, script, argument? } | { app, method, argument? })` installs and initializes one canonical managed Generative App module under `<agent-dir>/genapps/<app>/<app>.mjs`, or invokes one named method on an installed app. Installation rejects silent replacement and noncanonical/symlink sources. Methods receive immutable JSON state, one optional JSON argument, cancellation, revision, and a bounded non-shell process port; successful state changes commit to `state.json` plus `states.jsonl`, while output-only methods leave history unchanged. After one-shot `tgbtn` resolution, a complete `app::method` or `app::method(<strict JSON>)` prompt invokes the installed app before Pi queue admission and sends its planned Markdown/buttons directly; malformed or failed bound actions never fall back to a model prompt. Direct app-output buttons retain hidden source revisions and stale actions fail before method execution; sibling processes serialize transitions and recover dead lock owners. Bound actions send a fresh message by default and retain the clicked button's selected state on its prior surface. A result may opt into `viewMode: "edit"` to replace the callback message and keyboard in place, with one fresh-send fallback only for that explicit action. Agent-mediated initial-surface revisions, process-birth lock proof, automatic refresh, and voice output are not implemented.
- `telegram_confirm` and `telegram_choice` are [agent markup elements](#agent-selection-markup), not tools. Strict JSON in Markdown fences or HTML comments compiles to existing prompt buttons. A click produces ordinary user input containing the captured question, selection and metadata; buttons start neutral and color only after pressing. No agent Confirm/Choice/Task/Artifact tools are registered.
- `telegram_attach(paths, chat_id?, thread_id?, caption?)` is the stable artifact delivery tool for generated files. During Telegram turns it queues files before any separate final text; with `assistant.rendering: "rich"`, exactly one PNG/JPEG, MP4, or MP3 artifact plus non-empty final Markdown can become one reply-anchored Rich Message with media first. HTML mode, multiple/unsupported files, Guest Mode, and voice outputs retain their established paths. Outside Telegram turns the tool sends files directly to the paired/default chat, the registered follower's assigned thread, or an explicit `chat_id` plus optional `thread_id` when this Pi instance owns `/telegram-connect` or is registered with the multi-instance bus.
- `telegram_channel_post(action, operation_id, markdown?)` edits or deletes one exact `published` record returned by `telegram_channel_posts`. Edit requires Markdown and delete forbids it. A media-post edit replaces the caption through `editMessageCaption`, while a text post uses `editMessageText`; both render Markdown formatting, including spoilers, as Telegram HTML. The direct leader fences the tool call as outcome-unknown before the mutation call, so ambiguous failures are never replayed automatically.
- `telegram_channel_posts(chat_id?, limit?)` lists newest bounded records from the active profile's agent-owned post journal. It returns publication, edit/delete outcome-unknown, confirmed, and deleted local records only, including retained media kind/file name/size/SHA-256 identity; it never reads or claims completeness for Telegram channel history. This explicit successful listing is the only tool response that exposes retained authored Markdown; channel tool failures use fixed redacted messages, while pre-issuance media/caption validation errors stay actionable.
- `telegram_message(text, chat_id?, media?, channel?, thread_id?, thread?)` sends a direct Telegram Markdown message when this Pi instance owns `/telegram-connect` or is registered with the multi-instance bus. A public `@username`, or an exact negative numeric channel ID with `channel: true`, is passed as `chat_id` without a local registry; channel delivery requires the direct leader, and Telegram enforces whether the bot has channel posting permission. Channel delivery accepts `media` as one local `.jpg`/`.jpeg`/`.png`/`.webp` photo or `.mp4` video (photo ≤ 10 MiB, video ≤ 50 MiB), uploaded through multipart `sendPhoto`/`sendVideo` with `text` as its HTML caption (≤ 1024 visible characters); unsupported media types and albums are rejected before issuance, and the durable channel-post journal binds media identity and caption so duplicate or lost-acknowledgement retries never re-upload. `thread` accepts a live numeric Thread id or its current acknowledged display title; name matching is case-insensitive and fails closed when absent or ambiguous, while delivery captures the numeric target. During an active Telegram turn, omitted targeting and an explicit target equal to that turn are rejected so the ordinary final-reply path remains the sole current-target response; an explicit different chat/thread target remains allowed. Outside active turns, paired/default local/TUI delivery remains unchanged. Top-level `telegram_button` comments inside `text` are parsed with the same planner used for normal replies and attached to that message; buttons are never standalone Telegram messages.
- The bundled `telegram-bridge` Skill owns action syntax, target routing, Threaded Mode, formatting, Generative App operation, and profile-specific debugging guidance. The bundled `show-me` Skill owns portable evidence-honest explanations and adapts them to phone-width Markdown or self-contained HTML artifacts when Telegram is the active surface. The regular prompt routes applicable turns to these and the other bundled Skills. Compiled npm/git installations expose them through the package `pi.skills` manifest so Pi resource filters remain authoritative; a raw TypeScript checkout under Pi's `extensions` directory contributes its source Skill root at runtime instead. Existing agent tools (`telegram_attach`, `telegram_bind`, `telegram_message` and channel tools) remain registered but are model-active only while this instance owns direct transport or holds a live follower registration; disconnect/loss suppresses their schemas and prompt metadata, and recovery restores only the operator's previously active pi-telegram subset.
- `telegram_voice` hidden comments request Telegram-native voice delivery through `{text}`, `{text|lang}`, `{text|lang|rate}`, or a JSON object. JSON is the fallback for multiline content, named fields, or escaping; equivalent `text` or `value` supplies the spoken payload, with explicit `text` taking precedence.
- `telegram_button` hidden comments create footer buttons; standalone `telegram_button` fenced blocks create button rows between paragraphs in Native Rich Markdown. Delimiter lines tolerate horizontal indentation and whitespace before the exact name. Open with at least three backticks or tildes; close on a separate line with the same marker and no shorter a run, allowing only surrounding spaces/tabs. Enclosing code fences keep button-block examples literal. Both accept the same singleton or mixed JSON/CML matrix and share prompt/app routing; both wrappers also accept adjacent complete JSON/CML cells and matrices with optional separators, concatenating their normalized rows in source order. Cells remain singleton rows and nested horizontal rows retain their grouping. Native rows allow at most eight buttons and must fit one Rich Message chunk; invalid or incomplete blocks register nothing. Drafts hide action fences. HTML compatibility projects fenced controls into the footer. In-body clicks acknowledge without recoloring the Rich body; selected-style highlighting remains footer-only. One marker accepts a JSON object, adaptive JSON/CML matrix, or positional [Compact Matrix Literal](./compact-matrix-literal.md). Named JSON objects and positional cells may coexist in one matrix or row; separators are optional and one trailing comma is tolerated at matrix, row, and JSON-object boundaries. Top-level cells become full-width rows, while nested rows group one or more buttons horizontally without an artificial parser-width cap. CML uses `{value}`, `{label|prompt}`, prompt-only `{|prompt}`, or the corresponding three-atom form with `selected_style`; an omitted label uses the existing prompt-as-label fallback, and the optional third atom requires a non-empty prompt and accepts only `primary`, `success`, or `danger`. A fourth atom accepts `1` or `true` (disabled), and `0` or `false` (enabled), with exact lowercase spelling; an omitted fourth position stays enabled, and the third atom may be empty in this form (`{|Next||1}`). JSON uses boolean `disabled`. Disabled cells need no prompt or selected style: `{Next|||1}` is label-only and `{|||1}` is blank (JSON `{"label":"Next","disabled":true}` and `{"disabled":true}`). The Telegram renderer supplies a non-breaking space only when the label is empty. Disabled cells stay visible but carry `disabled: {}` instead of callback data and register no prompt or bound action; invalid disabled values reject the candidate matrix. It trims atom boundaries and supports only the minimal escapes `\|`, `\}`, and `\\`. Prefer one matrix comment for multiple buttons. Use JSON `label` plus `prompt`, or `value` when both strings are identical. Action markers are colon-free; colon-prefixed payloads are rejected. HTML action comments activate regardless of surrounding Markdown; escape their opening delimiter for literal examples. Button fences require standalone delimiter lines outside enclosing code examples and quote/list prefixes, but allow horizontal indentation. Bare JSON/CML in prose never activates.

Prompt guidance is context-aware: local/TUI prompts see only explicit direct-delivery guidance, while Telegram-originated turns receive the full action-comment syntax and phone-width output contract.

See [Outbound Handlers](./outbound.md) for exact markup forms.

## Configuration API

Configuration lives in `~/.pi/agent/telegram.json` unless `PI_CODING_AGENT_DIR` changes the agent root.

Stable config keys:

```ts
interface TelegramBotProfile {
  botToken: string; // literal token or exact $NAME / ${NAME} environment reference
  botUsername?: string; // runtime-managed
  botId?: number; // runtime-managed
  allowedUserId?: number;
}

interface TelegramConfig {
  profiles?: Record<string, TelegramBotProfile>; // includes `default`
  inboundHandlers?: TelegramInboundHandlerConfig[];
  attachmentHandlers?: TelegramInboundHandlerConfig[]; // compatibility alias
  outboundHandlers?: TelegramOutboundHandlerConfig[];
  assistant?: {
    draftPreviews?: boolean;
    rendering?: "rich" | "html";
    activity?: "quiet" | "thinking" | "tools" | "verbose";
    timeInjection?: "hidden" | "always" | "interval";
  };
  voice?: {
    replyMode?: "manual" | "mirror" | "always";
  };
  time?: {
    interval?: number;
  };
  threads?: {
    automaticCleanup?: boolean;
    displayMode?: "letters" | "names" | "directory-snake" | "directory-title";
  };
}
```

Bot/session identity always persists under `profiles.<name>`. The ordinary setup path uses `profiles.default`; `/telegram-setup default` and `/telegram-connect default` are exact aliases for the bare commands. Named profiles use the same shape. A profile holds only bot identity and its paired owner; shared handlers plus every Settings-menu preference (`assistant`, `voice`, `time`, and `threads`) remain top-level and apply to all profiles. On the first `0.24.0` load, unambiguous legacy root identity moves atomically into `profiles.default`; identical duplicates collapse, complementary fields merge, and conflicting values fail closed without modifying the file.

The file is global across Pi instances and contains configuration only. The per-profile polling/admission cursor is `acceptedThroughUpdateId` in that profile's private durable update journal; it is not a config key. On first connection after this cut, a legacy config cursor is transferred directly into the journal before polling and then removed from config. Journal publication failure preserves the legacy source; config publication failure leaves the journal authoritative so retry is idempotent. Cooperating instances serialize recursive config delta merges through `telegram.json.transaction` and preserve unrelated global/profile changes from newer disk snapshots. A semantically unchanged merge adopts the latest disk state in memory without replacing the file; later commits win when two deltas intentionally change the same leaf. Same-parent temp-file replacement retries bounded transient `EPERM`, `EACCES`, and `EBUSY` destination contention without deleting the live config or leaving transaction serialization. For manual edits, stop or idle the connected instances, publish a complete valid file atomically, and let them reload. A non-transactional editor racing Pi persistence has no same-leaf conflict guarantee.

Threaded Mode Settings exposes **Thread display** as Letters (default), Names, `directory-snake`, or `directory-title`; retained `directories` is unsupported, resolves to Letters, and is never rewritten automatically. `threads.displayMode` is shared by every profile; absent and invalid values resolve to `letters`. The retired `profiles.<name>.threadDisplayMode` key is ignored, not migrated. Another profile's already-running leader applies a shared change at its next startup or display reconciliation. Settings previews the current binding set through the same projector used for fresh titles and reconciliation. A manual `/name` override appears as `custom`; choosing any automatic Thread display option clears that override for the current Thread and immediately reapplies the selected projection. Names projects the generated dictionary name for the slot; the two directory modes tokenize Unicode path segments deterministically and render snake case or humanized title case, with `_a` or ` A` slot suffixes when required. The leader serializes preference persistence and title reconciliation, while a follower sends an authenticated `follower.setThreadDisplayMode` request gated by `thread-display-mode-v1`, the additional `directory-display-format-v1` capability for either new directory mode, and its exact registration generation. Config writes check the originating authority inside the config transaction; mode changes preserve target IDs, slots, generated recovery names, manual overrides, and queue ownership. `/name` mutations carry their originating target through final binding validation. The caller confirms only after application succeeds. A partial failure may leave the preference saved and some titles updated; Settings reports that state and permits retry. Acknowledged follower titles arrive through heartbeat rather than a new read loop.

Manual cleanup is independent of the graceful-quit toggle. On the leader instance, Settings → Thread cleanup → Review inactive tabs prepares only exact inactive bindings with complete clear protection, including bindings without a letter. Review and Back delete nothing. The separate Clean action confirms deletion of those eligible Telegram tabs and all their messages, not Pi session history or project files. Confirmation reloads and revalidates the exact review under a one-shot manual fence. Changed or protected bindings are skipped; an issued unknown deletion is never retried automatically, and unfinished local commit retains recovery protection. Follower instances do not receive a remote cleanup grant from these controls.

Hidden/default semantics are represented by absence:

- `threads.automaticCleanup` defaults to `true`; graceful Pi quit deletes the instance's bound Threaded Mode tab without prompting but preserves the owner slot as independent restart intent. Set it to `false`, or use `🧹 Thread cleanup` in Telegram Settings, to preserve the tab too. A confirmed `/telegram-disconnect`, unlike quit, clears restart ownership. Settings views and cleanup reload shared config before evaluating this switch, so another live Pi instance's update takes effect without restarting. Confirmed leader/follower teardown persists an exact target/runtime-generation cleanup intent before Telegram deletion; an interrupted attempt remains retryable by the current or successor leader under current authority and clears only after confirmed deletion. A same-profile replacement leader first adopts any still-active binding and cancels its superseded cleanup, so startup never deletes and recreates a reusable thread. If a follower's graceful envelope is missed, the leader may create the same fenced cleanup only after its heartbeat is stale, the OS confirms the exact registered PID no longer exists, cleanup remains enabled, and no replacement registration can overtake deletion. Heartbeat loss alone, live/unknown process liveness, IPC failure, and auth failure remain non-destructive. Invalid-config recovery makes the setting unresolved and therefore skips destructive cleanup. Manual `/telegram-disconnect` keeps its confirmation and teardown behavior regardless of this setting.
- Every complete intermediate assistant text block from a Telegram-originated turn is delivered once to its immutable target before the existing final reply; final and terminal-partial segments stay with settlement to prevent duplicate replies. While Telegram transport remains authorized, local/autonomous work also projects every completed public block, including commentary and the final block. This connected companion projection is always active and excludes token deltas, hidden reasoning, tool calls/arguments/results, empty blocks, unknown sources, and stale authority. Projection uses the configured Rich or HTML assistant renderer and binds admitted work to the exact target, profile/token transport generation, direct leader epoch or follower registration generation, and session generation. Retired top-level and `assistant.proactivePush` keys are ignored; the nested key is removed during config normalization.
- `assistant.draftPreviews` defaults to `true` when absent; explicit `true` or `false` values, including compatibility aliases, remain authoritative. Reading the default does not persist or migrate configuration. Telegram Settings writes the canonical field.
- `assistant.activity` accepts exactly `"quiet"`, `"thinking"`, `"tools"`, or `"verbose"`; omitted values default to `"verbose"`, explicit values remain unchanged, and invalid values fail closed to `"quiet"`. Each Pi process reloads the shared file-backed value at `agent-start`, so multi-instance activity isolation never relies on a stale process-local config snapshot. `thinking` shows only provider-exposed thinking, `tools` shows only completed tool activity, and `verbose` shows both. Thinking uses persistent ordinary HTML `sendMessage`/`editMessageText` disclosure with a standard expandable blockquote, a `🧠` header carrying the current Pi thinking level, and bounded redacted text whose inline Markdown renders as Telegram HTML. Tools use native Rich Messages with one header followed by separate closed details and JSON pre blocks for bounded redacted arguments, retained updates, and results/errors. Thinking disables link previews on every HTML send/edit and neutralizes HTTP(S) auto-link detection; Rich tool output disables automatic entity detection, with the same protections retained by its HTML fallback. Consecutive tools coalesce only inside the same ordered activity segment and bounded message. Legacy `assistant.activityVerbosity` is read only when `assistant.activity` is absent and is removed by the next Activity Settings write.
- Voice Reply `hidden`: no `voice.replyMode` key is persisted; legacy `manual` resolves to this silent default. `mirror` adds `[voice] delivery: automatic voice` only to voice/audio-input turns, while `always` adds the same effective line to every Telegram turn.
- Agent activity status is not configurable. While Telegram transport remains authorized, Telegram uses native `sendChatAction(typing)` / product `...active` status as the automatic in-chat work signal for unsettled agent and compaction work. Extension-owned blocking UI prompts pause it and completion resumes it while either work owner remains active.
- `assistant.timeInjection` accepts `hidden`, `always`, or `interval` and defaults to `interval` when absent without migrating an explicit stored value. Settings writes the selected value there, including `hidden`; the old `time.injectionMode` key is ignored and is not migrated. `time.interval` remains the optional interval duration in milliseconds.

With `assistant.rendering: "rich"` (the default), assistant Markdown delivery is native: final replies are sent as `InputRichMessage.markdown` via `sendRichMessage`, and draft previews use `sendRichMessageDraft` when a structurally closed preview frame is available. Draft-frame failures are recorded and skipped rather than converted into raw plain preview messages, because partial Markdown can be temporarily invalid while the final answer remains valid. Long native replies are split at Telegram Rich Message transport limits, with oversized fenced code, display-math, and fully wrapped inline-formatting blocks rewrapped per chunk so persisted chunks remain structurally valid. Guest replies use `InputRichMessageContent` in `answerGuestQuery` results. Bridge-owned UI surfaces such as menus, status, queue controls, commands, and sections keep explicit Telegram HTML/plain rendering by default because those texts are authored by the bridge or companion extensions for Telegram UI. Companion extension sections may explicitly request `"markdown"`, `"html"`, or `"plain"` per view. `assistant.rendering: "html"` keeps the compatibility path that converts assistant Markdown to Telegram HTML before ordinary message delivery. Assistant replies, previews, guest replies, and Rich attachment captions leave automatic entity detection enabled, so valid Telegram bot commands and URLs in semantic model output retain their native affordances; explicit Markdown links still belong in the Markdown source. Technical thinking/tool evidence remains a separate literal surface that suppresses link previews and automatic entities.

Environment variables are stable only where documented in the README: bot-token bootstrap, proxy behavior, agent root, and inbound/outbound file size limits.

## Programmatic API Matrix

High-level stable APIs:

- `registerTelegramSection()`
  - Identity: required `id`.
  - Purpose: managed menu/settings UI surfaces.
- `registerTelegramCommand()`
  - Identity: command name.
  - Purpose: explicit opt-in Telegram-native slash commands for companion workflows.
- `registerTelegramStatusLineProvider()`
  - Identity: required `id`.
  - Purpose: compact companion status rows in the `/start` menu status text.
- `sendTelegramView()` / `editTelegramView()` / `deleteTelegramView()` / `sendTelegramChatAction()`
  - Identity: current process-local delivery generation and returned logical message handles.
  - Purpose: ownership-gated operational delivery to active-turn, current-instance, Classic-only aggregate, or explicitly authorized targets; Threaded Mode never writes to All.
- `registerTelegramActivityHandler()`
  - Identity: required stable `id`.
  - Purpose: normalized non-blocking Pi lifecycle activity with source identity and fresh delivery contexts.
- `registerTelegramVoiceTranscriptionProvider()`
  - Identity: required stable `id` for new code.
  - Purpose: STT fallback for voice/audio input.
- `registerTelegramVoiceSynthesisProvider()`
  - Identity: required stable `id` for new code.
  - Purpose: TTS fallback for Telegram voice replies.

Low-level stable buses:

- `registerTelegramUpdateHandler()`
  - Identity: no id.
  - Purpose: observe or consume raw Telegram updates before default routing. Its optional execution fence supplies cancellation and a required pre-effect authority check for long-running handlers.
- `registerTelegramInboundHandler()`
  - Identity: no id.
  - Purpose: generic Telegram-to-Pi transforms.
- `registerTelegramOutboundHandler()`
  - Identity: no id.
  - Purpose: generic final-reply transforms or voice command fallbacks.

Advanced stable diagnostics:

- `recordTelegramRuntimeEvent()`
  - Identity: caller supplies category.
  - Purpose: surface companion diagnostics in `/telegram-status`.

All registration APIs return a disposer. Companion extensions should call disposers on shutdown and re-register on session start when they recreate runtime state. Low-level bus APIs intentionally avoid ids and run in registration order. High-level provider/UI APIs require stable identity in their public contract so diagnostics, replacement, and cleanup are understandable. Generated voice-provider ids remain a temporary compatibility path where documented.

## Capability Inventory And Gap Classification

This inventory maps the complete bridge capability plane to its supported extension boundary. A capability may stay private deliberately; completeness means every meaningful capability has an explicit classification, not that every internal helper becomes public.

### Public now

- **Extension loading:** The root export loads the bridge as a Pi extension; companion code uses the domain subpaths below rather than importing root runtime state.
- **Telegram commands:** `/commands` registers explicit Telegram-native slash commands with scoped reply and prompt-enqueue ports.
- **Managed menu and Settings UI:** `/sections` registers main-menu views, Settings rows, namespaced callbacks, standalone callback-scoped messages, and diagnostics.
- **Programmatic target-aware delivery:** `/delivery` sends, edits, deletes, and signals operational views against active-turn, current-instance, Classic-only aggregate, or explicitly authorized targets through generation-bound logical handles. All is input-only in Threaded Mode.
- **Normalized lifecycle activity:** `/activity` registers non-blocking extension handlers for evidence-based run/source identity, assistant prose/reasoning segments, executed tools, compaction, and settlement with fresh delivery contexts.
- **Compact status projection:** `/status` contributes synchronous status rows to the `/start` menu.
- **Raw inbound update interception:** `/updates` observes or consumes Telegram updates before default routing and remains the low-level callback escape hatch.
- **Inbound content transforms:** `/inbound` adds Telegram-to-Pi text/media preprocessing after operator-configured handlers.
- **Final outbound transforms:** `/outbound` adds final text/voice transformation fallbacks and exposes redacted runtime-event recording.
- **Voice providers and policy helpers:** `/voice` registers STT/TTS providers and exposes stable voice-mode projections.
- **Keyboard structures:** `/keyboard` exposes inline-keyboard structural types without transport operations.
- **Agent-facing delivery:** `telegram_message` and `telegram_attach` retain ordinary text/file semantics. Confirm/Choice agent markup uses existing button actions and ordinary prompts, not new tool schemas or a raw JavaScript transport.

### Intentionally private

- **Credentials and raw transport:** Bot tokens, Telegram clients, unrestricted Bot API calls, polling, retry loops, offsets, and multipart/download internals stay private so companions cannot bypass pairing or open a second transport owner.
- **Ownership and multi-instance routing:** Locks, named-profile isolation, leader/follower IPC, authorization capabilities, thread provisioning, reconciliation, and sync assumptions stay bridge-owned.
- **Session and queue coordination:** Active turns, queue lanes, dispatch gates, abort/compaction state, previews, final-reply ordering, and session-bound context stores stay internal invariants rather than shared mutable extension state. Telegram targets identify Pi instances and resolve their current session at dispatch time; they are not public handles to immutable session files.
- **Core operator UI:** Built-in menus, model/thinking controls, rendering internals, prompt-template expansion, status diagnostics assembly, and thread naming remain core policy; companions extend them through commands, sections, and status providers.
- **Raw Pi runtime objects:** Companion APIs never return captured `ExtensionContext`, `ExtensionCommandContext`, session managers, or private session-replacement/runtime handles.

### Assessed and not required for 0.21

- **General managed callbacks outside Sections:** `/sections` owns callback namespacing, answers, edits, navigation and cleanup for interactive Settings toggles; `/delivery` renders operational views. The narrow [Confirm API](#confirm-api-unreleased) adds explicit binary questions on the existing Delivery runtime, not a general action registry. Arbitrary managed buttons outside Sections remain unrequired; `/updates` is the deliberate low-level escape hatch.

### Explicitly deferred

- **Declarative interaction APIs:** Confirm, Choice, Task View and Artifact SDK functions are locally implemented and unreleased. Agent Confirm/Choice markup is implemented locally through ordinary prompt buttons. Public Text Input/Attachment Request and broader composed input remain incomplete. See the [contract direction](#planned-declarative-interaction-apis); `telegram_attach` remains the separate agent reply-file path, not a substitute SDK.
- **General configuration mutation:** Companions own their configuration and Settings state. pi-telegram does not expose unrestricted mutation of `telegram.json`, profile identity, pairing, rendering, queue, or transport settings.
- **Process and session control:** Reload, new-session, fork, resume, process launch, and arbitrary Pi slash-command dispatch remain outside the Telegram companion API until Pi exposes safe async extension hooks.

The 0.21 platform boundary lets a public-import-only consumer own reasoning, intermediate-prose, and tool-row policy while pi-telegram retains target selection, transport, authorization, lifecycle safety, and delivery ordering. Activity-specific examples live in this documentation; the separate [`pi-telegram-extension-demo`](https://github.com/llblab/pi-telegram-extension-demo) project remains the maintained companion-extension reference.

## Commands

Import from `@llblab/pi-telegram/commands`. This registers Telegram slash commands only; it does not expose Pi slash commands and is unrelated to command-template handlers.

```ts
const off = registerTelegramCommand({
  name: "review",
  description: "Review queued work",
  showInMenu: true,
  emoji: "🧩",
  handler: async (ctx) => {
    await ctx.enqueuePrompt(`Review this work: ${ctx.args}`);
  },
});
```

Contract:

- Command names are Telegram Bot API names: lowercase `a-z`, digits, and `_`, up to 32 characters. Hyphenated names are rejected.
- Built-in bridge commands such as `/start`, `/compact`, `/next`, `/abort`, `/stop`, and hidden `/quit` are reserved and cannot be claimed by extensions.
- Duplicate extension command names are rejected. The disposer removes only its own command registration.
- Routing precedence is built-in bridge commands first, registered extension commands second, and prompt-template aliases after that. This lets an extension intentionally claim a command name; prompt-template owners can resolve collisions by renaming the template alias.
- `showInMenu` defaults to `false`. When `true`, `emoji` is required and the command appears in `/start` help with that marker; it also joins Bot API command sync only when `description` is provided, because Telegram command-list entries require descriptions. The emoji is prefixed to the Bot API description as well. Workflow/product commands should opt in deliberately instead of expanding the core command row by default.
- The command context currently provides `name`, `args`, `reply(text)`, and `enqueuePrompt(prompt)`. Use `enqueuePrompt()` when a command should create normal queued Pi work rather than perform immediate Telegram-side handling.
- Handler failures are isolated: the bridge records a `telegram-command` runtime diagnostic, sends a compact failure reply, and keeps Telegram polling/routing alive.

### Selected Preparation (Staged 0.53.0 Contract)

Registrations may additionally opt in with `selected.prepare(input)`. Exported types are `SelectedPreparationInput`, `SelectedCommandExecution` and `PreparedSelectedCommand`:

```ts
interface SelectedPreparationInput {
  readonly name: string;
  readonly args: string;
}
interface SelectedCommandExecution {
  assertCurrent(): void;
  reportCompleted(): boolean;
  reply(text: string): void;
}
type PreparedSelectedCommand =
  | { kind: "command-only"; execute(ctx: SelectedCommandExecution): void | Promise<void> }
  | { kind: "generated-prompt"; prompt: string };
// selected.prepare(input) returns a plan or undefined, synchronously or asynchronously.
```

Preparation is a trusted side-effect-free producer contract, not a sandbox. It receives only frozen name/args copies: no ordinary reply/enqueue ports, raw update or Pi context. Return `undefined` to refuse. Plans must contain exactly the branch fields above; generated text must be nonblank. The bridge captures the exact registration/callback and a frozen plan, checking source, recipient and registration before/after preparation and plan copying. Errors, invalid plans or stale authority refuse without handler/template fallback.

The approved execution contract calls `execute` once after release. Producers recheck `assertCurrent()` before mutations and after awaits, and explicitly `reportCompleted()` after required semantics. Acceptance is not exact worker removal ACK, delivery success or cleanup authority; returns/errors/replies never auto-complete. The generated branch has no execution callback: the bridge owns one exact normal prompt receipt and selected no-fold admission. Detached replies use independent recipient/registration authority after original disposal; lost reports, receipts or delivery never permit blind replay.

**Implementation boundary:** Public types, Commands preparation and both single-message leader producer branches are locally composed behind the negotiated root gate, advertised since 0.53.0. Command-only execution/source-ACK and detached replies remain separate. Generated input captures its existing worker admission/receipt owner before binding, admits the frozen text once after release through Queue/Turns without raw command media/inbound transforms or history folding, and confirms only exact original/acquiring-owner/recipient/prepared-payload receipt proof. The same warm worker may positively resolve durable readback without another enqueue; missing proof remains unconfirmed. No producer receipt/enqueue port is added. Ordinary dispatch still invokes `handler` only. Legacy registrations, extension groups (including command captions entering prompt coalescing), control input and follower execution remain unsupported. Channel policy and negotiated capabilities live in [Multi-Instance Bus](./multi-instance-bus.md#live-rebind-channel).

The staged core [unified command channel](./multi-instance-bus.md#live-rebind-channel) is package-private and does not widen this registration contract. Its supported built-ins/templates use captured registry plans for compatible leader selections and held followers; that is not follower opt-in for extension producers. Held/selected preparation, queue completion scopes and native journal ACK readers are not public commands/updates exports. Release 0.53.0 advertises the live-rebind capabilities. Neither a matching package version nor `selected.prepare` registration alone supplies negotiated peer/recipient authority, and the running Pi is not reloaded by this source change.

Core commands stay reserved for bridge lifecycle, transport ownership, queue safety, and essential operator controls. Opinionated workflow commands should live in companion extensions through this registry.

## Sections

Import from `@llblab/pi-telegram/sections`.

```ts
const unregister = registerTelegramSection({
  id: "@scope/my-extension",
  label: "🧩 My extension",
  order: 10,
  render: async (ctx) => ({
    text: "<b>My extension</b>",
    parseMode: "html",
    replyMarkup: {
      inline_keyboard: [
        [{ text: "▶️ Run", callback_data: ctx.callbackData("run") }],
      ],
    },
  }),
  handleCallback: async (ctx) => {
    if (ctx.action !== "run") return "pass";
    await ctx.enqueuePrompt("Run my extension workflow.");
    await ctx.answerCallback("Queued");
    return "handled";
  },
});
```

Contract:

- `id` is unique per active registry. Duplicate ids are rejected.
- `ctx.callbackData(action, payload?)` builds compact `section:` callbacks and validates Telegram's 64-byte limit.
- `ctx.edit()` auto-prepends the correct Back/Main-menu row. `ctx.open()` sends a standalone chat message without auto-navigation.
- Section dynamic-label, render, and callback errors are isolated, surfaced as callback popups where applicable, and reflected by `getTelegramSectionDiagnostics()` until the matching surface succeeds.

Full behavior: [Extension Sections](./sections.md).

## Telegram Delivery API

Import from `@llblab/pi-telegram/delivery`.

```ts
const sent = await sendTelegramView(
  {
    text: "<b>Indexing…</b>",
    parseMode: "html",
  },
  { scope: { kind: "instance" } },
);
if (!sent.ok) {
  recordLocalDiagnostic(sent.reason, sent.message);
}
```

The delivery runtime resolves its live binding on every call and returns structured failures for unavailable runtimes, missing or unauthorized targets, stale handles, invalid views, and transport failures. A logical handle may represent several chunked Telegram messages; edit and delete reconcile the whole logical view. If send or edit growth fails after materializing messages, the failure carries a valid partial handle for deterministic retry or cleanup. Followers route through the existing leader transport, and reload/session replacement invalidates old handles rather than retaining Pi contexts.

Full behavior: [Telegram Delivery API](./delivery.md).

## Confirm API (Unreleased)

**Unreleased implementation; `/new` and `/compact` are migrated locally, while remaining producer assessment and release validation are pending.** `openTelegramConfirm()` is a higher-level capability of the existing `@llblab/pi-telegram/delivery` API, not a separate package entrypoint or internal domain. It provides explicit binary confirmations for built-in commands and trusted companion extensions, not a new agent-callable tool or automatic interception of another extension's UI. Implementation is tracked in [BACKLOG.md](../BACKLOG.md#declarative-interaction-apis-minor-release). This source revision exposes `openTelegramConfirm()` and `TelegramConfirm*` public types on `/delivery`, without a legacy `Confirmation` alias. Released 0.58.3 does not expose this API, and this work has not reloaded the running Pi session.

Opening and waiting are separate so the original Telegram update can finish before a human answers:

```ts
import { openTelegramConfirm } from "@llblab/pi-telegram/delivery";

const opened = await openTelegramConfirm({
  owner: "@example/cache",
  scope: { kind: "instance" },
  question: "Clear the cache?",
  confirmLabel: "🗑 Clear",
  cancelLabel: "❌ Cancel",
  confirmStyle: "danger",
  timeoutMs: 60_000,
  signal,
});
if (!opened.ok) return;

// Wait outside the original Telegram update handler.
const decision = await opened.handle.result;
```

Parameters:

- `owner`: Stable producer identity; neither an authorization grant nor a secret.
- `scope`: Delivery-style active-turn, current-instance, or authorized explicit target resolution. No profile switching or fallback to All.
- `question`: Plain text, escaped and formatted by the bridge; the dialog must fit one message without chunking.
- `confirmLabel`, `cancelLabel`, `confirmStyle`: Two buttons configured within the existing [UI standard](./ui-style.md#confirmation-dialogs).
- `timeoutMs`: Optional integer lifetime from 1 to 2,147,483,647 milliseconds, defaulting to 86,400,000 (24 hours); validated before sending, with delivery wait counting toward it.
- `signal`: Producer cancellation. The producer must abort outstanding requests on unload/dispose or when the intended operation changes.

A successful open returns a handle with one decision promise:

```ts
type TelegramConfirmDecision =
  | { status: "confirmed" }
  | { status: "cancelled" }
  | { status: "expired" }
  | { status: "aborted" }
  | { status: "invalidated" };
```

The read-only handle contains `id`, exact `target`, Delivery `generation`, and `result`. `cancelled` means the user selected the negative choice; `aborted` means the producer cancelled. Opening failures are structured: unavailable runtime/target, unauthorized target, abort/expiry, transport rejection, or `commit-unknown`. An unknown send outcome is never automatically replayed and cannot leave a usable confirmation nonce behind. Settled-dialog cleanup failures do not change the decision. At most 256 answers may be pending in one runtime; further opens return `capacity-exceeded`. Malformed requests throw `TypeError` before transport.

`confirmed` means only that the user confirmed the displayed request, **not that an operation completed or gained execution authority**. The producer must recheck operation validity, target, and authorization after waiting. One-shot answer acceptance in the live runtime is not exactly-once business execution across process failure. The API does not expose captured Pi contexts, a generic `execute()` callback, forms, arbitrary choice sets, or restoration of pending confirmations after reload.

Runtime binding, answer acceptance and built-in command integration belong to [Confirmation Requests](./architecture.md#confirmation-requests-planned).

## Planned Declarative Interaction APIs

**Approved direction for the next minor release. Choice, Artifact Delivery and Task View are implemented and exported in this working tree; Text Input and Attachment Request remain planned public functions. These additions are not in released 0.58.3; local implementation/export does not prove that a running instance has loaded or accepted them.** Keep these primitive APIs as separate, straightforward functions rather than `openDialog({ kind, ... })`, a generic factory, component schema or execution framework. The composed agent markup layer has a [target delivery contract](./architecture.md#composable-interaction-surfaces-planned) and staged release gates alongside these primitives. Only the [implemented agent selection forms](#agent-selection-markup) are available in this working tree; the broader composed language is not fully delivered. Completion of the primitive APIs alone does not establish the full feature release; see the [pre-release composition boundary](./architecture.md#declarative-interaction-pre-release-composition-boundary).

> **Release scope:** removed private Text/Attachment source-ingress, capture, custody and warm-disposition foundations are preserved on local branch `wip/private-input-foundations` (see [BACKLOG.md](../BACKLOG.md)). This tree retains private question/publication/privacy prerequisites, not public Text/Attachment openers, an accepting source collector or production readiness.

- **`openTelegramChoice()` — unreleased implementation**: Ask for one of an immutable set of labelled IDs; return one typed selected ID or an explicit terminal outcome.
- **`openTelegramTextInput()` — public API still planned**: Retained private question and known-reply protection do not expose a public opener or production accepting source path. Removed source-ingress/custody foundations are held on `wip/private-input-foundations`. The adopted [shared Input standard](#shared-input-and-question-lifetime-standard-adopted) still requires next ordinary text for one exact-target Input, `/name` as a consumer, and private historical/foreign/cold-source protection before public exposure. It is not implemented by merely enabling question-lifetime policy.
- **`openTelegramAttachmentRequest()` — public API still planned**: Ask for exactly addressed bounded files under the [attachment preparation boundary](./architecture.md#attachment-request-preparation-planned-unwired); return matched artifacts/metadata under a documented local lifetime, not an agent prompt. No opener, collector or readiness is exposed.
- **`sendTelegramArtifact()` — unreleased implementation**: Send one bounded caller-selected document to an authorized target under the [artifact contract](#artifact-delivery-contract-unreleased); return an explicit receipt or classified uncertainty, never file-read/disclosure authority.
- **`openTelegramTaskView()` — unreleased implementation**: Present declarative progress updates and advisory cancellation requests under the [Task View contract](#task-view-api-unreleased), not global Pi control or proof that work stopped.

Opening an input request and waiting for its result remain separate; never block the original serialized update handler on a human. Reuse exact binding, finite request lifetime, abort/disposal and one-shot mechanics where applicable. Each function returns its own meaningful result, not a generic untyped dialog event. Producers retain semantic validation, authorization and execution. Known matched SDK answers must not enter the model queue; late, ambiguous and reloaded reply handling must be specified before input APIs ship. Password/token collection is not an intended use of text input.

Attachment input and artifact output are deliberately separate directions: a Telegram attachment addressed to an extension is not the same operation as sending a local file to Telegram. Task View builds on existing send/edit/delete handles; it does not own task execution or automatic global typing.

The canonical remaining work and acceptance boundaries live only in [BACKLOG.md](../BACKLOG.md#declarative-interaction-apis-minor-release). Existing Sections remain the owner for persistent managed menus/navigation; these APIs serve explicit producer-owned interactions.

### Shared Input And Question Lifetime Standard (Adopted)

This standard is approved for local implementation, not evidence that the running extension or public Text Input already implements it. It supersedes exact-reply-only as the target for new Text Input interactions; the retained exact-reply/private-custody primitives remain safety evidence, not production next-text readiness. Input/Confirm/Choice stay separate straightforward APIs, not a universal dialog factory.

- **One Input primitive:** Built-in `/name` consumes the same SDK Text Input mechanism as companion extensions. Producers supply the question heading and bounded configuration; common publication, controls, ownership, waiting and terminal mechanics stay in existing Delivery. Name validation, trimming, rename effects and Reset to automatic remain domain-owned. Preserve correction after invalid names without ordinary model fallback or deadline renewal; do not introduce a script/regex validator or workflow engine.
- **Addressing:** After sender admission and private/historical-input protection, recognized commands keep their normal command path. The next ordinary text in the same operator/profile/bot/chat/Thread scope belongs to its active Input, without requiring Reply. Only ordinary text with no positively active Input follows the ordinary agent route. An absent cache/marker/receiver is not proof that an old private answer is ordinary. Voice/media, edits and lifecycle commands retain existing restrictions until their owning implementation checkpoint explicitly proves a changed region; no implicit transcription or new collection mode is authorized.
- **Single active Input:** A new Input replaces the previous Input for that target, regardless of producer; the former producer receives an explicit replaced terminal outcome. Repeat `/name` opens the new Input through the same mechanism. Old controls and already-associated input cannot operate on the successor; replacing Input is not queueing it. This replacement rule does not automatically apply to Confirm/Choice. No producer effects run merely because a question opened.
- **Completion:** One successful text result ends Input; Cancel, replacement, timeout or original authority/session loss also end it. Controls start neutral and use standard `❌ Cancel`; optional domain controls remain limited, not arbitrary actions. Producer results remain outside model context. Opening and awaiting a human remain separate: never hold the serialized update handler, Workspace/config/source transaction or actual I/O lane while waiting for a human.
- **Question lifetime:** Input/Confirm/Choice default to 24 hours; an explicit shorter `timeoutMs`, abort or terminal outcome wins immediately. The actual SDK question and its controls must agree on remaining lifetime. Preserve existing explicit numeric timeout validation and deadline anchoring while the shared policy is integrated; taps/edits do not renew a request. Attachment, Task View, Artifact/file leases and system-menu lifetimes are not changed by this standard.
- **Head/tail:** The latest still-active question in a target is head for up to 24 hours. Multiple independent questions newly published by one positively owned footer ACK are one common co-head batch: every otherwise-live member is a head, not just the last declared/rendered question. That ACK demotes only previously published otherwise-live questions to tails for up to one hour from demotion, not first publication. Deadlines, answers, cancellation and terminal state remain individual; earlier producer/operation cutoffs still win. A later head demotes the otherwise-live members of the former batch; answering one member never promotes history or demotes its co-heads. A replaced Input is already terminal and gets no extra hour. A wizard sequence is one lifetime, not a batch of future heads; equal timestamps or separate ACKs do not imply a common batch. Existing capacity bounds remain, with no persistent registry or restart resurrection. Co-head semantics are adopted; [bounded private first-send membership](./architecture.md#common-co-head-batch-private-bounded-first-send) is now connected for bounded direct SDK/agent paths and [plain/native-app authenticated-follower first sends](./architecture.md#follower-question-birth-and-plain-first-send-root-bounded) with production 24-hour planner defaults. Follower membership additionally requires original local SDK/bot/provider and API registration authority plus a complete matching native Message ACK; mixed app first sends also retain one original native result binding across every question and bound row. [Remote callback feedback](./architecture.md#follower-callback-feedback-root-native-parent-membership-held) uses the actual edit Message and original API/parent authority to preserve valid captured callback execution, not by itself to grant app-parent child membership. The [bounded first read-only callback child](./architecture.md#follower-read-only-app-callback-child-root-bounded) additionally proves completed native feedback, the exact successor/invocation and complete first-physical parent/SDK ancestry; later feedback or equal-field result scopes do not renew it. [Pure-question child output](./architecture.md#follower-pure-question-callback-child-root-bounded) requires the same native result/invocation and first-parent proofs through its captured question origins, never a dummy ordinary control. The [queued-native-feedback subset](./architecture.md#follower-queued-native-feedback-child-root-bounded) preserves that exact invocation and parent through pending feedback I/O; its [bounded deferred form](./architecture.md#follower-deferred-native-feedback-child-root-bounded) waits for the original editor while retaining the child-ACK cohort and at most one authenticated later admission ceiling, including cancelled admission. Earlier producer cutoffs win; earlier/multiple admissions and unproved deferred histories remain held. [One original retained group](./architecture.md#follower-one-retained-original-group-root-bounded-native-rich) additionally preserves its original callback roster, selection, clock and first publisher through explicitly producer-owned native Rich input; the main-side fixture is not standalone-app retention intent. No public pending-head, conditional-clock or retention/discovery authoring API is added. [Bounded known-parent co-head edits](./architecture.md#bounded-co-head-known-parent-edits-private), including [plain follower Text/Rich and keyboard-only markup edits](./architecture.md#follower-plain-known-parent-edit-root-bounded), retain complete original parent/SDK-origin evidence and positive native ACKs; followers additionally join the actual edit Message, not the normalized public outcome. App questions with unavailable original app authority, physical histories outside the [bounded private paths](./architecture.md#one-retained-original-question-group-root-bounded-rich) and broader remote general app-parent/unproved mixed/retained/edit-first/non-superseding markup histories remain separately held; unavailable coordinated provenance retains independent UI rather than borrowing another owner.

**Implemented checkpoint (unreleased):** `timeoutMs` is optional for SDK Confirm/Choice and private Text Input, defaulting to 86,400,000 ms in the shared Delivery kernel. The original admission-time deadline, explicit integer range (1–2,147,483,647 ms), abort/authority fencing and required explicit Attachment timeout are unchanged. Root now joins bounded direct SDK/agent head/tail through original native registry/provider captures and synchronous admission forwarding; an ACK cannot capture a successor. Agent Confirm/Choice and ordinary/app prompt buttons default to 24 hours. Original app capture now joins bounded direct first-send questions. Ordinary selection separately checks its original producer/app authority: SDK-only loss or unavailable membership does not disable an otherwise-owned answer or reacquire an SDK scope. Unsupported parent and follower histories remain outside common coordination. The [SDK head/tail kernel](./architecture.md#sdk-headtail-kernel-private-opt-in) and [24-hour agent-default path](./architecture.md#agent-24-hour-default-private-opt-in) remain internal ownership mechanisms, not public options. App-parent/remote integration and live/platform acceptance remain separate; `/name` retains its five-minute dialog.

**Implemented checkpoint (private kernel):** A valid admitted same-context Text Input now replaces its predecessor with explicit `replaced` completion (or opening failure), including across producers. Old replies/controls/receivers cannot operate on the successor; failed/unknown publication cannot restore the former Input. Queued/issued openings retain their existing pool capacity until actual I/O drains, and excess admission does not spend the current Input. This is not next-text capture or a private-source settlement receipt; the public Text opener stays closed.

**Implemented receiver boundary (private):** Input must resolve to the original current instance receiver target. Permission to send ordinary output to another live Thread does not authorize collecting that Thread's next text: such explicit-target or active-turn Input requests fail `target-unauthorized`; own-target requests remain valid. Observed receiver-target loss, provider renewal or caught observation reentry cannot be undone by restoring equal fields. This does not add cross-owner delegation, alter ordinary delivery target policy or provide a source settlement receipt.

**Implemented preparation (current `/name`):** Command syntax follows the existing dispatcher instead of being collected as a name, including repeated `/name`, built-ins, extension commands, templates and the existing unknown-command fallback. Other commands leave the dialog's wait intact; ordinary slash-containing names retain their validation policy. This does not replace private/historical reply protection or migrate Name to the SDK kernel.

Modal next-text capture, the `/name` consumer and agent/SDK head-tail coordination remain separate acceptance checkpoints. Until each lands, its corresponding current behavior remains explicitly documented; do not enable Text publication/readiness or relax private source/peer gates to make an incomplete implementation callable. `openTelegramTextInput()` remains unexported until the accepting path is proved. Canonical remaining work stays in BACKLOG.

### Attachment Request Boundary (Planned)

No `openTelegramAttachmentRequest()` function or public attachment handle/result is exported. Current private question, publication, receiver and own-bot marked-reply privacy guards are prerequisites only; they do not activate file collection, native source disposition or producer handoff.

The removed native source-ingress/staging, captured-file seal, consumer-lease accounting and warm cancellation/expiry/refusal/disposition implementations and their acceptance records are preserved on `wip/private-input-foundations`, not supplied by this release candidate. Historical `completeEnd()`, `completeCancellation()` or reconciliation proofs on that branch must not be presented as callable current-tree capabilities. Re-landing requires the [canonical backlog gate](../BACKLOG.md#declarative-interaction-acceptance), not a readiness flag or a fresh wrapper around current getters.

The eventual collector must accept only exactly addressed files in the original operator/profile/bot/session/chat/Thread scope, enforce actual MIME/count/total-byte bounds and prove complete physical source membership before file-ID deduplication. An album debounce timer, ordinary download limit or declaration decoder is not whole-response admission or a file lease. No next-message capture, arbitrary path selection, implicit model/STT fallback or source ACK follows from a reply marker.

Durable admission-owned pins, original publication/receiver authority, authenticated peer compatibility, producer handoff, consumer lifetime and terminal/unknown/cold recovery remain required before a public opener or production readiness. File cleanup and source completion need their own positive receipts; time, absent data, a cancelled SDK result or logical worker completion cannot substitute. These requirements belong to the [Attachment preparation boundary](./architecture.md#attachment-request-preparation-planned-unwired); acceptance and publication remain separate.

### Task View API (Unreleased)

Import `openTelegramTaskView` and its `TelegramTaskViewRequest`, `TelegramTaskViewState`, `TelegramTaskViewStatus`, `TelegramTaskViewHandle`, `TelegramTaskViewEnd`, `TelegramTaskViewCancellation`, `TelegramTaskViewUpdateResult` and `TelegramTaskViewOpenResult` types from `@llblab/pi-telegram/delivery`. This working-tree API is not in released 0.58.3 or activated in this running session.

```ts
const viewLifetime = new AbortController();
const opened = await openTelegramTaskView({
  owner: "@example/export",
  scope: { kind: "instance" },
  title: "Export report",
  state: { status: "running", text: "Collecting records" },
  cancellable: true,
  timeoutMs: 300_000,
  signal: viewLifetime.signal,
});
if (opened.ok) {
  void opened.handle.cancellation.then(outcome => {
    if (outcome.status === "requested") {
      // Revalidate your task's ownership/validity, then optionally cancel YOUR work.
      // This is not a Pi abort grant or proof that cancellation succeeded.
    }
  });
  await opened.handle.update({ status: "running", text: "Writing report", progress: 0.6 });
  // Only after the producer's own work settles:
  await opened.handle.update({ status: "completed", text: "Report is ready", progress: 1 });
}
```

A request requires a nonblank `owner` (at most 256 UTF-16 units), well-formed nonblank plain `title` (128 units), initial `state`, finite integer `timeoutMs` (1–2,147,483,647 ms) and an `AbortSignal`. It uses `active-turn`, `instance` or an explicitly authorized `target`; aggregate is excluded. State contains `status: "running" | "completed" | "failed" | "cancelled"`, well-formed nonblank plain `text` (2048 units), and optional finite `progress` from 0 to 1. Omitted progress is indeterminate, not zero. Progress is rounded for display and never infers completion. Text/title are escaped, not interpreted as commands or assistant markup. Malformed declarations throw `TypeError` before transport.

Cancellation controls are opt-in (`cancellable` defaults to `false`). Optional `cancelLabel` is well-formed nonblank text up to 64 units, defaulting to **❌ Request cancel**. The exact original operator/profile/chat/Thread/message and live binding must still match. A valid click settles `handle.cancellation` once with `{ status: "requested" }`, retires the control and displays that producer acknowledgement is pending. It neither completes the view nor reports `cancelled`; the producer may still complete successfully. No arbitrary text reply is collected, no executor/context is supplied, and no global abort/quit or automatic typing is invoked. Do not wait for human cancellation inside a serialized update handler. Use a separate lifetime signal if your task's own abort signal must remain usable while reporting its cancellation acknowledgement.

The frozen handle has `id`, exact frozen `target`, `generation`, `cancellation`, `result`, `update(state)` and `close()`. It is not a raw Delivery handle and cannot be fabricated, serialized or restored. One message is backed by the existing Delivery handle/renderer/target queue. Updates retain one actual edit and at most one latest queued snapshot per view. Replacing a queued snapshot resolves its caller with `{ ok: true, value: { revision, status: "superseded" } }` without claiming it was displayed; a positively acknowledged current edit returns `"applied"`. Coalescing is not a fixed-rate scheduler. The first terminal update intent excludes later updates/cancellation; after its current acknowledgement it removes controls and settles `result` with that producer-reported terminal status. Those statuses are producer declarations, never independent evidence of business execution.

`close()` retires only the projection and settles `result` with `"closed"`; deadline, signal and owner loss settle `"expired"`, `"aborted"` or `"invalidated"`. If cancellation was never requested, `cancellation` instead settles `{ status: "closed", reason }`. Local retirement does not prove that an already-issued request drained or that cleanup reached Telegram. Known-message close/abort/expiry cleanup is single-attempt and authority-fenced; failed cleanup leaves inert controls without changing either promise. Actual work remains visible to the existing target-drain owner until it settles. Both runtime replacement and equal-object rebinding revoke public handles; observed authority/callable loss cannot revive by restoring equal values.

Opening and update failures include `effect: "not-issued" | "unknown"`. This is deliberately conservative: `not-issued` means no corresponding transport adapter invocation occurred; after invocation, absence of a current positive acknowledgement is treated as `unknown`, even when diagnostics may describe a rejection. It is not HTTP issuance provenance or a retry grant. Unknown initial publication returns no usable handle/nonce. An uncertain edit retires the projection without automatic retry or a compensating edit; it also blocks close/abort/expiry cleanup already queued behind that edit. Logical abort settles pending/in-flight update callers promptly, preserving this distinction while actual I/O drains. Task Views share the existing 256 pending-interaction limit with Confirm, Choice and private Text requests. Reload discards their process-local lifetimes, not the producer's business task.

### Choice API (Unreleased)

Import `openTelegramChoice` and its request/option/handle/decision/open-result types from the existing `@llblab/pi-telegram/delivery` entrypoint:

```ts
const opened = await openTelegramChoice({
  owner: "@example/export",
  scope: { kind: "instance" },
  question: "Choose export format",
  choices: [
    { id: "json", label: "🧾 JSON", style: "primary" },
    { id: "csv", label: "📊 CSV" },
  ],
  cancelLabel: "❌ Cancel",
  timeoutMs: 60_000,
  signal,
});
if (!opened.ok) return;
// Wait outside the original serialized update handler.
const decision = await opened.handle.result;
if (decision.status === "selected") {
  // Recheck operation validity and authorization before using decision.choiceId.
}
```

- **Declaration:** `choices` is a snapshotted readonly list of 1–64 unique nonempty string IDs with nonempty labels; this is the initial API resource bound, not a claimed Telegram platform maximum. Each option may have `style: "primary" | "success" | "danger"` and a boolean `disabled`. Values use separate vertical rows followed by Cancel. Disabled rows have no callback and cannot settle the request, including forged taps. Use Sections for persistent/large navigable menus.
- **Result:** The frozen handle has `id`, exact `target`, Delivery `generation`, and `result`. Decisions are `{ status: "selected", choiceId: string }` or `{ status: "cancelled" | "expired" | "aborted" | "invalidated" }`. IDs are returned unchanged; neither IDs nor extra request fields grant native-command authority.
- **Lifecycle:** Reuses Confirm's exact operator/message/target/profile and captured transport-owner binding, queue admission, finite timeout/abort, shutdown invalidation and inert unknown-send policy. Confirm and Choice share a bounded pool of 256 pending questions. A request must fit one rendered message; timeout starts at admission, including queue/transport wait. Opening and waiting are separate.
- **Failure:** Opening returns structured Delivery/lifecycle failures, including capacity refusal and commit-unknown. Invalid declarations throw `TypeError` before transport. Old bindings without Choice return `runtime-unavailable`. Terminal keyboard cleanup is best-effort and cannot change the selected result or replay an operation.
- **Transport:** Direct UI calls enforce the guard at native API admission. Follower UI uses an explicitly local issuance/ACK fence; no function is serialized or claimed as leader execution authority. Leader registration/target authorization remains separate. Already-issued RPC/network work cannot be retroactively unsent; a late or uncertain publication cannot revive a settled nonce.

### Artifact Delivery Contract (Unreleased)

**Implemented and exported in the local source and generated package, not in released 0.58.3 or activated in the running session.** Direct and authenticated follower source/native and compiled-native fixtures passed locally; supported-platform and live acceptance remain separate. The API sends one local regular file as a document. It does not infer photo/audio modes, convert content, send albums, accept URLs/file IDs, or fall back to another publication. Import `sendTelegramArtifact` and these types from the existing `@llblab/pi-telegram/delivery` membrane:

```ts
interface TelegramArtifactRequest {
  owner: string;
  scope: Exclude<TelegramDeliveryScope, { kind: "aggregate" }>;
  file: { path: string; name: string };
  caption?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

interface TelegramArtifactReceipt {
  readonly kind: "document";
  readonly target: Readonly<TelegramDeliveryTarget>;
  readonly generation: string;
  readonly messageId: number;
  readonly fileName: string;
  readonly byteLength: number;
}

type TelegramArtifactEffect = "not-issued" | "rejected" | "unknown";
type TelegramArtifactFailureReason =
  | "runtime-unavailable" | "target-unavailable" | "target-unauthorized"
  | "capacity-exceeded" | "source-unavailable" | "source-invalid"
  | "source-changed" | "size-exceeded" | "aborted" | "expired"
  | "invalidated" | "transport-rejected" | "transport-failed" | "commit-unknown";
type TelegramArtifactResult =
  | { ok: true; receipt: TelegramArtifactReceipt }
  | {
      ok: false;
      reason: TelegramArtifactFailureReason;
      effect: TelegramArtifactEffect;
      message: string;
      observedReceipt?: TelegramArtifactReceipt;
    };

declare function sendTelegramArtifact(
  request: TelegramArtifactRequest,
): Promise<TelegramArtifactResult>;
```

- **Declaration:** Snapshot the request and resolved target synchronously before awaits. `owner` is a nonblank producer correlation label, not authority. `file.path` is an explicit absolute local path; `file.name` is a nonblank well-formed basename, neither `.` nor `..`, at most 255 UTF-8 bytes, without separators or control characters. Caption is optional well-formed plain text of at most 1,024 UTF-16 units; never truncate, parse markup or silently rename. `timeoutMs` is a required integer 1–300,000 and `signal` is required. Invalid declarations throw `TypeError` before filesystem/network effects; older/missing artifact runtime bindings return unavailable without fallback.
- **Deliberate first-slice bounds:** Capture 1–1,048,576 bytes; lower runtime/outbound policy wins. Admit one outstanding artifact operation per Delivery runtime and one per leader runtime. Refuse contention instead of queueing payloads. These are SDK resource choices, not Telegram limits or changes to the generic 50 MiB attachment default. Capacity stays reserved while corresponding actual filesystem/native work remains outstanding, even if the public wait ends earlier.
- **File selection:** The producer authorizes reading/disclosing its resolved source. Symlink resolution, including the final component, is permitted; parent-path trust is not a sandbox. Bind applicable resolved-path observations to one validated regular descriptor, read bounded bytes through it, and reject observed identity/size/change races. The selection anchor is validated open/fstat, not an atomic snapshot at JavaScript invocation. Metadata checks cannot detect every unobserved ABA or concurrent rewrite. Close only after pending reads settle. Queue privately captured bytes, never reopen the source for upload; later source mutation/deletion cannot change those bytes. Never delete the original. There is no outbound consumer lease or temporary-file custody.
- **Target and lifetime:** Only current active-turn, instance or authorized exact-target scopes; no profile switching, channel/aggregate expansion or Threaded All output. Capture the actual runtime binding, route, active-turn identity where applicable, profile/bot, session, transport and acknowledged registration incarnation. Rebind/reload/replacement cannot renew or retarget the operation. Validate target/capability/capacity before disclosure-relevant I/O; the nonrenewing deadline includes capture and target-queue wait. Abort prohibits future issuance but cannot unsend already-issued work or guarantee kernel-I/O cancellation.
- **Publication:** One SDK transport attempt, one native upload attempt, no 429/family/reply-anchor/media retry or fallback. Use the existing queue, drain, API target activity and Workspace admission owners. The strict follower byte protocol requires both peers' support; no paths, functions or file descriptors cross IPC, and no generic multipart downgrade is allowed. Caller-local guards are not authenticated leader execution grants.
- **Result:** Success needs a validated positive message identity under original authority. A document receipt is not a text-view handle and cannot be passed to `editTelegramView()`; no media edit/delete API is added. `not-issued` requires proof that the original attempt never reached HTTP, not merely that a rejected duplicate issued nothing. `rejected` requires definitive Telegram rejection provenance. Lost/invalid ACK, issued network/5xx/malformed success, late authority loss and ownership-record failure are `unknown` without conclusive original-operation evidence. A surviving positive identity is diagnostic `observedReceipt`, not renewed authority. Diagnostic/recovery faults cannot rewrite native rejection or observed issuance. Messages are redacted; producers retain business/disclosure decisions and must not blindly resend uncertain work.
- **Bounded memoization:** Artifact bodies are not retained in bus fingerprints/results after actual settlement. Exact duplicates share one retained attempt only under current original authority. Ledger eviction/restart and arbitrary raw same-incarnation replay are outside durable exactly-once guarantees; the SDK never automatically resends an operation. Source/receipt absence is not outcome proof. The [internal contract](./architecture.md#artifact-delivery-unreleased-bounded) defines incarnation-aware cache admission, outcome projection and native acceptance gates. Text Input/v4 readiness remains independent and closed.

## Declarative UI Markup (Planned)

**Local unreleased Confirm/Choice agent rendering is implemented; Text/Attachment markup and SDK-private input integration remain planned.** Nothing here is claimed as released 0.58.3 or automatically loaded into a running session. Shared validation lives in `outbound-markup`; agent rendering, storage and callbacks stay with `outbound-buttons`. No new public package entrypoint, agent tool or generic dialog API.

### Agent Selection Markup

Use strict JSON in `telegram_confirm` / `telegram_choice` Markdown fences or HTML comments. Both render escaped bold question text with neutral footer controls, even in Rich mode, allowing the existing post-click keyboard feedback. Choice `style` and Confirm `confirmStyle` select the pressed color only; default feedback is primary. Existing legacy in-body buttons remain unchanged.

For example, a comment body is `telegram_choice {"question":"Format?","choices":["JSON","CSV"]}` between `<!--` and `-->`. Or put the same JSON object in a `telegram_choice` fence. Comment delimiter rules match `telegram_button`, including activation inside code; escape the opener for literal examples.

The existing `tgbtn` store retains the fully captured prompt and original per-question deadline. A supported single-question click queues ordinary user input as bare JSON: `{"question":"Format?","answer":"JSON"}`. The answer is the visible selected label. No selection tags, version, kind, status, authored ID or SDK result envelope enters model context. IDs and semantic cell values remain optional authoring/internal data. `promptKind` stays bridge-local so text such as `app::method` cannot enter the bound-method parser. No SDK Promise, agent tool, business execution or private SDK-to-agent forwarding is introduced. Each scalar Confirm/Choice is one completion group: the first branch consumes every sibling association before external queue callbacks. Ordinary prompt peers remain independent. Completing/cancelling a collector removes its remaining associations before transport and queue admission; failed/unknown edits close the shared collector associations. Logical retirement does not wait for TTL and never re-arms after a queue or display error. Footer controls are disabled best-effort under the original callback execution guard, retaining only post-press color; in-body/timed retirement remains separate backlog work.

A Choice question array now means a sequential wizard, not independent prompts. A question with `select:N` requires exactly N enabled options. Exact-N selection is implemented locally: tap to toggle checkmarks/color; the cancel control shows selected/required counts. Reaching N automatically closes the controls and admits one `{"question":"Pick two","answer":["A","B"]}` prompt, in declaration order. Cancel sends the original question and cancel label, not a partial set. Intermediate taps never enqueue prompts. A wizard shows only its current question and numeric step count; completion advances through an atomic edit of that same message, preserving surrounding Markdown and other controls in the original Rich/HTML mode. Only finishing the last step admits one ordered JSON array, including for a one-question wizard. Separate blocks stay independent. At most 16 recognized declarations and 64 selection cells activate per final reply; overflow creates no selection controls. Validate a complete block before registering any cell. Invalid blocks show a bounded noninteractive diagnostic; incomplete fences publish nothing. Complete/partial drafts hide recognized declaration bodies.

Text/file request elements below are only private normalization/future contracts, not active agent receivers. Artifact output uses existing ordinary attachment delivery; Task View remains an SDK producer capability rather than an agent state-inspection tool.

### Names, Envelope And Common Fields

The exact fence names are `telegram_confirm`, `telegram_choice`, `telegram_text_input` and `telegram_attachment`. Each body is strict JSON. Choice admits a top-level array of sequential question objects. Confirm also accepts a JSON string as shorthand for its question; the other forms remain objects. Unknown properties and explicit nulls are invalid, rather than ignored or coerced. There is no `telegram_wizard`, TOML body, outer `surface` or executable handler field.

- **`question`:** Required nonempty text, trimmed, at most 1,024 UTF-16 code units. After trimming, declaration strings are well-formed Unicode without control characters or line separators. Question copy is rendered bold as text, not interpreted as HTML or commands.
- **`id`:** Optional authored semantic reference, at most 128 units. Agent prompts neither require nor expose it. Supplied question IDs must be unique within a batch; equal question text with no IDs is valid. This field never grants callback or execution authority.
- **`timeoutMs`:** Optional explicit integer 1–3,600,000. Omitted Confirm/Choice timeout defaults to 86,400,000 (24 hours); the reserved private Text/Attachment normalization defaults remain 300,000. The deadline starts at finalized planning, including publication wait, and is enforced by existing button storage. A wizard uses the earliest declared question timeout as its whole-sequence deadline. Taps/advancement never renew it. One unref store-owned nearest-deadline timer retires expired associations without further input and stops when empty; no dialog waiter is added. Session start and current-session shutdown clear callbacks immediately; an old shutdown continuation cannot clear successor work.
- **`cancelLabel`:** Optional nonempty text up to 128 units. Default `❌ Cancel`, except Confirm's `❌ No`. Producers can supply localized copy. Runtime-derived operator/profile/session/target/message/revision/nonces and abort/disposal are never JSON fields.
- **Bounds:** At most 65,536 UTF-16 units per declaration, 16 recognized agent declarations and 64 normalized selection cells per finalized answer. Independently, the existing button store holds at most 60 unresolved callback associations across prompt/app-bound buttons and agent selections, separate from the SDK question pool and the 60-message system-menu store. Disabled cells consume no callback slots. Capacity is checked before real registration, including widest future wizard steps plus independent controls; a publication exceeding 60 refuses as a whole. Pool pressure retires the oldest complete group, not an arbitrary choice branch; progression does not reset its original eviction age. Source/body and collection bounds are checked before publication. Lower runtime transport/media/security limits take precedence. These are v1 resource limits, not claimed Telegram platform maxima.

Callback completion, capacity eviction and expiry best-effort disable acknowledged footer controls under their original session/transport authority. This preserves message text and unrelated menu/SDK controls; failures never renew callbacks or synthesize an answer. Unknown edits fence cleanup instead of overwriting a possibly newer view. Native edits/cleanup for that message are serialized and shutdown drains actual work. Canonical in-body Rich controls likewise disable in the latest acknowledged plain-Markdown body through that guarded lane. Cleanup preserves surrounding text, literal code and the current footer; it never replays media, HTML/blocks or other producer payloads. A body snapshot above 65,536 units is not retained for background rewriting. Native app-owner observations also close stale app-bound callbacks when no replacement view is displayed; an unchanged read-only call or failed initialization does not invalidate the current owner. Foreign filesystem changes are observed on later native access/callback/publication, not through a new watcher; fixed TTL remains the idle fallback. A visible retired control after skipped/failed cleanup is not an active callback grant. Known time expiry uses `Expired:`; capacity removal uses `Unavailable:` with a limit-specific refusal. Unknown history is reported as unavailable rather than proof of elapsed TTL; none of these statuses admits a prompt or app action.

### Element-Specific Fields

- **Confirm:** `confirmLabel` defaults to `✅ Yes`; `confirmStyle` is optional `primary | success | danger`. Labels use the same 128-unit limit. Confirm/No supplies a decision, never executes its semantic operation; existing public Confirm/native authority boundaries remain unchanged.
- **Choice:** Required `choices` is a named cell, an array of string labels or cells/rows, or a string containing the JSON/CML adaptive matrix grammar. `select` is an optional integer defaulting to 1; it cannot exceed the number of enabled choices. Counts above one activate finite exact-N collection, not independent per-click prompts. One top-level cell is one vertical row; an immediate nested cell array is one horizontal row. At most 64 options total, 64 rows and 8 cells per row, with at least one enabled option; deeper arrays and empty rows are invalid.
- **Choice cells:** Only `label`, `value`, `style`, `disabled`. Label falls back to value, and value to label. Enabled labels/values are nonempty and limited to 128/256 units; enabled values are unique within a question. Disabled may be empty and never settles input. `disabled` is a boolean defaulting to false; `style` uses the three shared styles. Machine values remain internal selection identities, not agent prompt fields or standalone commands; styles are post-click only in agent markup.
- **Text Input:** `maxLength` is an integer 1–16,384, default 4,096; `multiline` is a boolean defaulting to false. These constrain the eventual submitted answer, not merely client display. No regex/script validator or password/token collection.
- **Attachment Request:** `accept` is 1–16 unique case-insensitive MIME filters, normalized lowercase; default `["*/*"]`. A concrete MIME, `type/*` and `*/*` are allowed; filename extensions are not filters. `maxFiles` is 1–10, default 1. `maxBytes` is a total-response byte bound, 1–20,971,520, default 10,485,760, further constrained by configured download/media limits. Filters do not establish trusted content.
- **Separate operations:** SDK Artifact Delivery sends caller-selected artifacts; SDK Task View projects producer-owned progress/cancellation. Neither becomes an implicit attachment sender, raw file-reader, task-launching block or global Pi abort. Additional markup families need a concrete contract.

### JSON/CML Boundary And Canonical Matrix

The outer declaration remains JSON; compact or mixed Choice syntax is carried as the `choices` string. Named JSON cells inside that string can coexist with positional cells. Reuse CML v4 matrix depth, separators and escapes; preserve existing `telegram_button` semantics unchanged. For Choice, positional cells mean `{label|value|style|disabled}`, not label/prompt. One atom supplies label and value; existing disabled/optional-slot rules apply before Choice-specific validation.

Both string and native-JSON representations normalize to the same immutable ordered rows. Canonical serialization emits JSON rows or compact/mixed CML, preserving semantics rather than original spelling. Quoted labels that could look like named JSON and explicitly blank disabled labels with nonempty values stay named cells in compact output; there is no unsafe reinterpretation. Outer JSON does not inherit CML's tolerant cell trailing-comma handling. Malformed JSON-looking cells, unknown keys/styles, duplicate enabled values and invalid matrices fail the entire declaration without partial activation.

### One Question, Sequential Wizard And Independent Blocks

An object is a single question. An array of 1–32 question objects declares a sequential Choice wizard: only the current question is displayed, and completion returns an ordered array of plain question/answer pairs. Option-row arrays inside each object's `choices` describe layout only. `select:N` makes that question's answer an array of labels. Both are implemented locally. A wizard plus its entire surrounding composed view must fit one editable message for every future question. A projection using the longest future headings checks this before registering real callbacks; oversized views produce a noninteractive diagnostic, not chunk spill or partially published controls.

````markdown
```telegram_choice
[
  {
    "question": "Which report format?",
    "choices": ["🧾 JSON", "📊 CSV"]
  },
  {
    "question": "Which two sections should be included?",
    "choices": ["Charts", "Tables", "Notes"],
    "select": 2
  }
]
```
````

The requested wizard advances predeclared questions without model turns; exact-N selection accumulates/toggles choices before completion. Skill guidance, not a generic workflow API, decides when these capabilities are useful. Arbitrary branching and SDK result mirroring are out of scope. Cancel ends the wizard and sends only completed question/answer pairs plus the current question with its cancel label; uncompleted multi-selection sets and unseen questions are omitted. Unknown edit outcomes close the shared collector footer without advancing again or admitting partial answers. Native mocked direct/follower Rich/HTML checks are local evidence, not operator-loaded Telegram acceptance.

### Results, Input And Publication

An admitted SDK/app publication resolves a private structured result through its narrow producer API; existing signatures/statuses are not changed. Agent Confirm/Choice compiles to ordinary user input containing only captured question/answer JSON, with an ordered array for wizards and a label array for exact-N answers. No fake tool/system role, SDK result forwarding or executable value is created.

Completed single-question clicks are ordinary user requests, including Confirm No. Wizard/multiselect intermediate taps are UI state changes only, not independent prompts. Expired actions create no unsolicited model turn. SDK private result/custody remains separately governed by its own producer contracts; markup does not adopt those collectors or their recovery authority. See [architecture](./architecture.md#composable-interaction-surfaces-planned).

Text/file input must reply to the exact request message in its bound target. Each pending receiver has a distinct message; captions/media are not text answers and ordinary unmatched input keeps normal routing. Reject edits and unsupported/mixed/partial albums for the request rather than silently taking a subset. Downloaded files remain admission-owned/pinned while held; after handoff they have an explicit `expiresAt` and a ten-minute default consumer lease capped by runtime policy. Consumers copy artifacts they need longer; cleanup cannot remove live held-source artifacts. No automatic transcription or model fallback for SDK uploads.

Planned fence framing follows existing button framing: at least three matching backticks or tildes, exact name, standalone closing marker no shorter than opening; indentation/outer whitespace permitted. Enclosing code fences and quote/list-prefixed examples are literal. Confirm/Choice also accept exact named HTML comments; Text/Attachment comment activation is not implemented. Previews suppress active declaration bodies; only complete final valid blocks can publish. Invalid recognized blocks produce bounded noninteractive diagnostics, never partial controls; independent valid blocks remain independent. Overflow of the answer-wide declaration bound activates none. Existing button/comment extraction retains precedence in agent-authored source, including raw HTML action delimiters inside code. A literal opener inside a JSON string can use JSON Unicode escaping (for example, \\u003c for the less-than character); decoded declaration strings are never rescanned for legacy actions. This preserves existing delimiter semantics rather than silently making a Markdown context deactivate comments.

Detailed lifecycle/ownership belongs to [architecture.md](./architecture.md#composable-interaction-surfaces-planned); remaining implementation and release gates belong only to [BACKLOG.md](../BACKLOG.md#composable-interaction-surfaces-delivery). These normalized schemas do not make parser-only evidence live UI acceptance.

## Telegram Activity API

Import from `@llblab/pi-telegram/activity`.

```ts
const off = registerTelegramActivityHandler({
  id: "@scope/activity-view",
  async handle(event, ctx) {
    if (event.type !== "tool-start") return;
    await ctx.send({
      text: `Tool: ${event.toolName}`,
      parseMode: "plain",
    });
  },
});
```

Handlers receive ordered normalized events but run outside Pi's critical lifecycle path. Each handler has an isolated asynchronous queue; adjacent high-frequency deltas may coalesce while semantic boundaries remain ordered. Activity contexts choose active-turn delivery for Telegram-owned work and instance delivery for local/autonomous/unknown work, delegating every operation through the current `/delivery` generation.

Full behavior and consumer policy examples: [Telegram Activity API](./activity.md).

## Status Lines

Import from `@llblab/pi-telegram/status`.

```ts
const off = registerTelegramStatusLineProvider(
  ({ activeModel }) => {
    if (activeModel?.provider !== "example-provider") return undefined;
    return { label: "service", value: "ready" };
  },
  { id: "@scope/example-status" },
);
```

Contract:

- Providers are synchronous because `/start` status text is rendered inline with the menu.
- Return `undefined` when the line is not relevant for the active model.
- Provider failures are isolated and skipped so optional companion status cannot break the core Telegram menu.
- The bridge renders rows as `<Label>: <value>` in the same HTML status block as Status, Tokens, Cache, Cost, and Context, capitalizing the first label character for Telegram UI consistency. Tokens contains only `↑` input and `↓` output totals. Cache groups `R` cache-read tokens, `W` cache-write tokens, and `CH` for the latest assistant request's `cacheRead / (input + cacheRead + cacheWrite)`, shown to one decimal place only after the session reports cache activity. These precise labels avoid conflating token telemetry with companion-provided usage-limit rows.

## Updates

Import `registerTelegramUpdateHandler`, `TelegramUpdateExecutionFence`, and the advanced `getTelegramUpdateExecutionFence`, `createTelegramUpdateExecutionFenceGuard`, `carryTelegramUpdateExecutionFence`, and `assertTelegramUpdateExecutionCurrent` helpers from `@llblab/pi-telegram/updates`.

```ts
const off = registerTelegramUpdateHandler(async (update, execution) => {
  const data = (update as { callback_query?: { data?: string } }).callback_query
    ?.data;
  if (!data?.startsWith("myext:")) return "pass";
  await handleMyCallback(data, execution?.signal);
execution?.assertCurrent();
  return "consume";
});
```

Use this as a low-level escape hatch. Prefer sections for menu-integrated UI.

Full behavior: [Updates](./updates.md).

## Inbound

Import from `@llblab/pi-telegram/inbound`.

```ts
const off = registerTelegramInboundHandler("document", async ({ file }) => {
  if (!file?.mimeType?.includes("pdf")) return undefined;
  return await extractPdfText(file.path);
});
```

Priority order:

1. configured `inboundHandlers`
2. compatibility `attachmentHandlers`
3. programmatic inbound handlers
4. voice transcription providers
5. built-in text-file fallback

Full behavior: [Inbound Handlers](./inbound.md).

## Outbound

Import from `@llblab/pi-telegram/outbound`.

```ts
const off = registerTelegramOutboundHandler("text", async (text) => {
  return await rewriteFinalText(text);
});
```

Programmatic outbound handlers are fallbacks/transformers behind operator-owned `telegram.json` configuration. Voice delivery priority is configured voice handlers, then programmatic `voice` handlers, then synthesis providers.

Full behavior: [Outbound Handlers](./outbound.md).

## Voice Providers

Import from `@llblab/pi-telegram/voice`.

```ts
const offStt = registerTelegramVoiceTranscriptionProvider(
  async (file) => {
    if (file.kind !== "voice" && file.kind !== "audio") return undefined;
    return { text: await transcribe(file.path) };
  },
  { id: "@scope/my-extension/stt" },
);

const offTts = registerTelegramVoiceSynthesisProvider(
  async (text, options) => {
    return await synthesizeOggOpus(text, options);
  },
  { id: "@scope/my-extension/tts" },
);
```

Stable voice-provider registrations pass a durable `id`. Omitting `id` is a compatibility path for older providers and receives a generated session-local id. Providers return `undefined` to pass. TTS providers must return `.ogg` or `.opus` files for native Telegram voice notes.

Full behavior: [Voice Integration](./voice.md).

## Public API Smoke Examples

Minimal companion-extension examples that import only stable `@llblab/pi-telegram/*` public membranes. Copy one into an extension `index.ts`, load it beside `pi-telegram`, and verify that it starts without importing any `@llblab/pi-telegram/lib/*` implementation path.

### Extension Sections

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramSection } from "@llblab/pi-telegram/sections";

export default function demoSection(pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    unregister?.();
    unregister = registerTelegramSection({
      id: "demo-section/status",
      label: "🧩 Demo section",
      order: 50,
      render: () => ({
        text: "<b>Demo section</b>\n\nThis section was rendered by a companion extension.",
        parseMode: "html",
        replyMarkup: { inline_keyboard: [] },
      }),
    });
  });
  pi.on("session_shutdown", async () => {
    unregister?.();
    unregister = undefined;
  });
}
```

### Raw Update Handler

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";

export default function demoUpdates(pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    unregister?.();
    unregister = registerTelegramUpdateHandler((update) => {
      if (!update || typeof update !== "object") return "pass";
      return "pass";
    });
  });
  pi.on("session_shutdown", async () => {
    unregister?.();
    unregister = undefined;
  });
}
```

### Inbound Handler

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramInboundHandler } from "@llblab/pi-telegram/inbound";

export default function demoInbound(pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    unregister?.();
    unregister = registerTelegramInboundHandler("text/*", async (file) => {
      if (!file.path.endsWith(".demo.txt")) return undefined;
      return `Demo inbound handler saw ${file.fileName ?? file.path}`;
    });
  });
  pi.on("session_shutdown", async () => {
    unregister?.();
    unregister = undefined;
  });
}
```

### Outbound Handler

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramOutboundHandler } from "@llblab/pi-telegram/outbound";

export default function demoOutbound(pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    unregister?.();
    unregister = registerTelegramOutboundHandler("text", async (text) => {
      if (!text.includes("[demo-outbound]")) return undefined;
      return text.replace("[demo-outbound]", "Demo outbound handler:");
    });
  });
  pi.on("session_shutdown", async () => {
    unregister?.();
    unregister = undefined;
  });
}
```

### Voice Providers

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerTelegramVoiceSynthesisProvider,
  registerTelegramVoiceTranscriptionProvider,
} from "@llblab/pi-telegram/voice";

export default function demoVoice(pi: ExtensionAPI) {
  let unregisterTts: (() => void) | undefined;
  let unregisterStt: (() => void) | undefined;
  pi.on("session_start", async () => {
    unregisterTts?.();
    unregisterStt?.();
    unregisterTts = registerTelegramVoiceSynthesisProvider(
      async (text) => {
        return await synthesizeDemoOgg(text);
      },
      { id: "demo-voice/tts" },
    );
    unregisterStt = registerTelegramVoiceTranscriptionProvider(
      async (file) => {
        if (file.kind !== "voice" && file.kind !== "audio") return undefined;
        return { text: `Demo transcript for ${file.fileName ?? file.path}` };
      },
      { id: "demo-voice/stt" },
    );
  });
  pi.on("session_shutdown", async () => {
    unregisterTts?.();
    unregisterStt?.();
    unregisterTts = undefined;
    unregisterStt = undefined;
  });
}

async function synthesizeDemoOgg(_text: string): Promise<string> {
  throw new Error("Replace synthesizeDemoOgg with a real OGG/Opus generator.");
}
```

### Smoke Checklist

- The extension imports only public package membranes: `@llblab/pi-telegram`, `/commands`, `/sections`, `/status`, `/delivery`, `/activity`, `/updates`, `/inbound`, `/outbound`, `/voice`, or `/keyboard`.
- It does not import `@llblab/pi-telegram/lib/*`.
- It registers on `session_start` and disposes on `session_shutdown`.
- Stable high-level registrations use durable ids.
- Failures are visible during manual testing through `/telegram-status` or extension-owned logging.

## Callback Namespaces

Owned prefixes are reserved by `pi-telegram`: `compact:`, `new:`, `tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `settings:`, and `section:`.

Companion extensions should use their own short prefix for raw callbacks or use `ctx.callbackData()` inside sections. Unknown unowned callbacks may be forwarded to Pi as `[callback] <data>` after built-in handlers decline them.

Full behavior: [Callback Namespaces](./callback-namespaces.md).

## Internal Surface

The following are not stable public contracts unless explicitly documented elsewhere:

- queue/runtime/lifecycle stores and planners
- menu implementation helpers
- polling/lock internals
- Telegram API transport helpers
- rendering internals
- command implementation helpers
- test support functions

They are intentionally not exposed through a `./lib/*.ts` export wildcard in `0.12.0`.
