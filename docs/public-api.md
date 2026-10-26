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

Hidden compatibility shortcuts may open sections directly: `/help`, `/status`, `/model`, `/thinking`, `/queue`, and `/settings`.

This command surface is a mobile companion subset, not a raw terminal-command bridge or session browser. A Telegram destination follows its assigned Pi instance and sends prompts into that instance's currently active session; it is not permanently bound to one session identity. Compaction and new-session replacement operate on the current session; resume, fork, tree navigation, session switching, TUI transcript clearing, and arbitrary slash-command dispatch stay out of the stable Telegram API unless Pi exposes safe public extension hooks for them.

An unbound Thread chooser offers **⛔️ Cancel routing** to the current paired owner for any input it routes: text, commands, any attachment kind and albums alike. The only condition is that every source supports exact private retention. It retains the original privately without sending it to Pi or deleting its Telegram message/Thread. This is not `/abort` or `/stop`: already selected, partially forwarded, queued or running work cannot be cancelled here. Failed cancellation or chooser updates retain the same button for exact retry. When the current leader has protected attempts, **Status → ❌ Pending cancellations** opens owner-only review with up to five supported inputs per page. Finish cancellation preserves the original and starts no new delivery; previously accepted work may continue. Refresh, navigation, reload and ownership changes invalidate old controls. Corrupt retention evidence stays protected without implicit repair. After a restart, an input still waiting for its choice gets its original chooser back, with working buttons and the same deadline, while its tab is unbound; inputs whose choice was already made stay protected until their deadline. Existing retained attempts remain recoverable. Historical unbound startup text is still held before default routing, but the Historical inputs menu entry and its review/Stop retrying submenu are removed. Previously published historical callbacks are answered as unavailable; they neither reopen the view nor authorize routing or abandonment. Hiding this technical state does not establish non-delivery or cancel independently accepted work. Confirmed eligible unbound prompt choosers now retain a fixed 60-minute deadline from first positive publication acknowledgement; refresh/restart does not renew it. Validated selection freezes expiry before effects; browsing or unavailable targets does not. Expiry retains the exact unselected original privately before pending-journal removal and invalidates stale controls, without Thread deletion, Pi stop or task-completion reporting. Selected/accepted/uncertain work and historical or unconfirmed clocks remain protected; no tab-disappearance signal is required. The journal lifetime capability and carrier hooks are package-private, not a new companion API. Live acceptance passed in the operator's 0.52.0 live smoke.

### Tools and assistant-authored actions

Every assistant-authored HTML comment is transport-private on Telegram: previews and final replies remove `<!-- … -->` blocks regardless of Markdown nesting or which extension owns the comment, and complete recognized comments activate voice or buttons independently of surrounding whitespace or Markdown, including code fences. Escape the opening delimiter as `&lt;!--` for literal examples. Unclosed comment tails are withheld and a comment-only result sends no text message; Pi's terminal transcript remains unchanged.

- `telegram_bind({ app, script, argument? } | { app, method, argument? })` installs and initializes one canonical managed Generative App module under `<agent-dir>/genapps/<app>/<app>.mjs`, or invokes one named method on an installed app. Installation rejects silent replacement and noncanonical/symlink sources. Methods receive immutable JSON state, one optional JSON argument, cancellation, revision, and a bounded non-shell process port; successful state changes commit to `state.json` plus `states.jsonl`, while output-only methods leave history unchanged. After one-shot `tgbtn` resolution, a complete `app::method` or `app::method(<strict JSON>)` prompt invokes the installed app before Pi queue admission and sends its planned Markdown/buttons directly; malformed or failed bound actions never fall back to a model prompt. Direct app-output buttons retain hidden source revisions and stale actions fail before method execution; sibling processes serialize transitions and recover dead lock owners. Bound actions send a fresh message by default and retain the clicked button's selected state on its prior surface. A result may opt into `viewMode: "edit"` to replace the callback message and keyboard in place, with one fresh-send fallback only for that explicit action. Agent-mediated initial-surface revisions, process-birth lock proof, automatic refresh, and voice output are not implemented.
- `telegram_attach(paths, chat_id?, thread_id?, caption?)` is the stable artifact delivery tool for generated files. During Telegram turns it queues files before any separate final text; with `assistant.rendering: "rich"`, exactly one PNG/JPEG, MP4, or MP3 artifact plus non-empty final Markdown can become one reply-anchored Rich Message with media first. HTML mode, multiple/unsupported files, Guest Mode, and voice outputs retain their established paths. Outside Telegram turns the tool sends files directly to the paired/default chat, the registered follower's assigned thread, or an explicit `chat_id` plus optional `thread_id` when this Pi instance owns `/telegram-connect` or is registered with the multi-instance bus.
- `telegram_channel_post(action, operation_id, markdown?)` edits or deletes one exact `published` record returned by `telegram_channel_posts`. Edit requires Markdown and delete forbids it. A media-post edit replaces the caption through `editMessageCaption`, while a text post uses `editMessageText`; both render Markdown formatting, including spoilers, as Telegram HTML. The direct leader fences the tool call as outcome-unknown before the mutation call, so ambiguous failures are never replayed automatically.
- `telegram_channel_posts(chat_id?, limit?)` lists newest bounded records from the active profile's agent-owned post journal. It returns publication, edit/delete outcome-unknown, confirmed, and deleted local records only, including retained media kind/file name/size/SHA-256 identity; it never reads or claims completeness for Telegram channel history. This explicit successful listing is the only tool response that exposes retained authored Markdown; channel tool failures use fixed redacted messages, while pre-issuance media/caption validation errors stay actionable.
- `telegram_message(text, chat_id?, media?, channel?, thread_id?, thread?)` sends a direct Telegram Markdown message when this Pi instance owns `/telegram-connect` or is registered with the multi-instance bus. A public `@username`, or an exact negative numeric channel ID with `channel: true`, is passed as `chat_id` without a local registry; channel delivery requires the direct leader, and Telegram enforces whether the bot has channel posting permission. Channel delivery accepts `media` as one local `.jpg`/`.jpeg`/`.png`/`.webp` photo or `.mp4` video (photo ≤ 10 MiB, video ≤ 50 MiB), uploaded through multipart `sendPhoto`/`sendVideo` with `text` as its HTML caption (≤ 1024 visible characters); unsupported media types and albums are rejected before issuance, and the durable channel-post journal binds media identity and caption so duplicate or lost-acknowledgement retries never re-upload. `thread` accepts a live numeric Thread id or its current acknowledged display title; name matching is case-insensitive and fails closed when absent or ambiguous, while delivery captures the numeric target. During an active Telegram turn, omitted targeting and an explicit target equal to that turn are rejected so the ordinary final-reply path remains the sole current-target response; an explicit different chat/thread target remains allowed. Outside active turns, paired/default local/TUI delivery remains unchanged. Top-level `telegram_button` comments inside `text` are parsed with the same planner used for normal replies and attached to that message; buttons are never standalone Telegram messages.
- The bundled `telegram-bridge` Skill owns action syntax, target routing, Threaded Mode, formatting, Generative App operation, and profile-specific debugging guidance. The bundled `show-me` Skill owns portable evidence-honest explanations and adapts them to phone-width Markdown or self-contained HTML artifacts when Telegram is the active surface. The regular prompt routes applicable turns to these and the other bundled Skills. Compiled npm/git installations expose them through the package `pi.skills` manifest so Pi resource filters remain authoritative; a raw TypeScript checkout under Pi's `extensions` directory contributes its source Skill root at runtime instead. `telegram_attach`, `telegram_bind`, and `telegram_message` remain registered but are model-active only while this instance owns direct transport or holds a live follower registration; disconnect/loss suppresses their schemas and prompt metadata, and recovery restores only the operator's previously active pi-telegram subset.
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
    activity?: "quiet" | "thinking" | "tools" | "verbose" | "stream";
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
- `assistant.activity` accepts exactly `"quiet"`, `"thinking"`, `"tools"`, `"verbose"`, or `"stream"`; omitted values default to `"verbose"`, explicit values remain unchanged, and invalid values fail closed to `"quiet"`. Each Pi process reloads the shared file-backed value at `agent-start`, so multi-instance activity isolation never relies on a stale process-local config snapshot. `thinking` shows only provider-exposed thinking, `tools` shows only completed tool activity, and `verbose` shows both. `stream` projects thinking, compact tool lines, and the live answer tail inside one edited-in-place message per turn (native draft previews pause; the streamed message is deleted when the final answer is delivered). Thinking uses persistent ordinary HTML `sendMessage`/`editMessageText` disclosure with a standard expandable blockquote, a `🧠` header carrying the current Pi thinking level, and bounded redacted text whose inline Markdown renders as Telegram HTML. Tools use native Rich Messages with one header followed by separate closed details and JSON pre blocks for bounded redacted arguments, retained updates, and results/errors. Thinking disables link previews on every HTML send/edit and neutralizes HTTP(S) auto-link detection; Rich tool output disables automatic entity detection, with the same protections retained by its HTML fallback. Consecutive tools coalesce only inside the same ordered activity segment and bounded message. Legacy `assistant.activityVerbosity` is read only when `assistant.activity` is absent and is removed by the next Activity Settings write.
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
- **Agent-callable delivery:** `telegram_message` and `telegram_attach` provide ownership-gated text/file delivery to the agent, not a JavaScript companion-extension transport API.

### Intentionally private

- **Credentials and raw transport:** Bot tokens, Telegram clients, unrestricted Bot API calls, polling, retry loops, offsets, and multipart/download internals stay private so companions cannot bypass pairing or open a second transport owner.
- **Ownership and multi-instance routing:** Locks, named-profile isolation, leader/follower IPC, authorization capabilities, thread provisioning, reconciliation, and sync assumptions stay bridge-owned.
- **Session and queue coordination:** Active turns, queue lanes, dispatch gates, abort/compaction state, previews, final-reply ordering, and session-bound context stores stay internal invariants rather than shared mutable extension state. Telegram targets identify Pi instances and resolve their current session at dispatch time; they are not public handles to immutable session files.
- **Core operator UI:** Built-in menus, model/thinking controls, rendering internals, prompt-template expansion, status diagnostics assembly, and thread naming remain core policy; companions extend them through commands, sections, and status providers.
- **Raw Pi runtime objects:** Companion APIs never return captured `ExtensionContext`, `ExtensionCommandContext`, session managers, or private session-replacement/runtime handles.

### Assessed and not required for 0.21

- **General managed callbacks outside Sections:** The documented issue #126 consumer shape needs interactive Settings toggles, not interactive activity rows. `/sections` already owns stable callback namespacing, callback answers, edits, navigation, and cleanup for those toggles; `/delivery` can render the resulting non-interactive activity views. A second callback registry would duplicate ownership without a proven use case, while `/updates` remains the deliberate low-level escape hatch for consumers that truly need raw callback interception. Revisit only when a public-import-only consumer must generate managed callbacks independently of a registered Section context for arbitrary delivered messages.

### Explicitly deferred

- **Programmatic artifact/media delivery:** `telegram_attach` covers agent-authored artifacts, while companion JavaScript has no general file/media send contract. The first 0.21 delivery slice targets operational text/activity views; media should earn a typed extension only from a concrete companion use case.
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
- Built-in bridge commands such as `/start`, `/compact`, `/next`, `/abort`, and `/stop` are reserved and cannot be claimed by extensions.
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
