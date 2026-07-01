# pi-telegram

![pi-telegram screenshot](screenshot.png)

**Telegram runtime adapter for Pi.**

`pi-telegram` turns a private Telegram DM into a session-local operator console for Pi. It admits work, preserves context, streams readable replies, keeps busy sessions usable through queues, and turns assistant-authored intent into native Telegram artifacts.

The product shape is a mobile companion for a live Pi session: start work in the terminal, then continue from Telegram on the couch or outside. It is not a remote terminal, PTY supervisor, or process launcher. Companion extensions can add commands, sections, status rows, handlers, and voice providers while `pi-telegram` keeps ownership of transport, queueing, and reply policy.

This repository is an actively maintained fork of [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram). It started from upstream commit [`cb34008`](https://github.com/badlogic/pi-telegram/commit/cb34008460b6c1ca036d92322f69d87f626be0fc) and has since diverged substantially.

## What this gives you

- **Mobile supervision**: continue a live Pi session from Telegram without turning Telegram into a fake terminal.
- **Telegram-native controls**: menus, settings, queue controls, native active status, Rich Markdown replies, drafts, buttons, voice, files, and artifacts.
- **Safe runtime mapping**: Telegram turns map into Pi lifecycle, queueing, model switching, compaction, previews, final replies, and ownership rules.
- **Optional Threaded Mode**: one leader and visible follower Pi processes can share one bot through named Telegram threads.
- **Extension platform**: companion extensions can add Telegram-native commands, sections, status rows, update handlers, handlers, and voice providers without owning polling.

Use this README for the product shape. Follow the docs for exact contracts.

## Install

From npm:

```bash
pi install npm:@llblab/pi-telegram
```

From git:

```bash
pi install git:github.com/llblab/pi-telegram
```

## Connect

### 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Pick a name and username
4. Copy the bot token

### 2. Configure the bot token in Pi

Start Pi, then run:

```bash
/telegram-setup
```

Paste your bot token when prompted. If a bot token is already saved in `~/.pi/agent/telegram.json`, the setup prompt shows that stored value by default. Otherwise it prefills from the first configured environment variable in `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, or `TELEGRAM_KEY`. The saved config file is written atomically with private `0600` permissions.

### 3. Connect this Pi session

```bash
/telegram-connect
```

The adapter is session-local: only one Pi instance polls Telegram at a time. In classic mode, `/telegram-connect` records external control/polling ownership in `~/.pi/agent/locks.json`. When Telegram private-chat Threaded Mode is available for the bot, `/telegram-connect` uses the local Telegram organism automatically: the first live instance becomes leader, later live instances register as followers instead of taking over while the leader heartbeat is healthy. Local queue and reply state stay per Pi instance, so an instance that loses Telegram control still finishes work it already accepted.

### 4. Pair your Telegram account

1. Open the DM with your bot in Telegram
2. Send `/start`

The first user to message the bot becomes the exclusive owner of the adapter. Messages from other users are ignored.

### Environment-only configuration

Most day-to-day controls live in the Telegram menu or Pi commands. A few important runtime knobs intentionally stay in environment variables because they affect bootstrap, networking, or transport limits before a menu can help:

- **Bot token bootstrap**: `/telegram-setup` can prefill from `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, or `TELEGRAM_KEY` when no token is already saved.
- **HTTP/HTTPS proxy**: native `fetch` can use `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` when Node's environment proxy mode is enabled. Use `NODE_USE_ENV_PROXY=1` or start Node with `--use-env-proxy`. SOCKS5 is not part of the zero-dependency core. If you need it, run a local HTTP-to-SOCKS bridge or system tunnel and point `HTTP_PROXY` / `HTTPS_PROXY` at the HTTP endpoint.
- **Telegram network family**: `PI_TELEGRAM_NETWORK_FAMILY=auto|ipv4|ipv6|ipv4-fallback` controls Bot API transport only. The default is `ipv4-fallback`: try native `fetch` first, then retry transport-level failures through IPv4-only HTTPS. Use `auto` to force native `fetch` only, or `ipv4`/`ipv6` to force a family.
- **Agent data root / temp location**: `PI_CODING_AGENT_DIR` changes the base agent directory used for `telegram.json`, locks, generated outbound-handler artifacts, and Telegram temp files. When unset, the adapter uses `~/.pi/agent`, so inbound Telegram files land in `~/.pi/agent/tmp/telegram`.
- **Inbound file limit**: `PI_TELEGRAM_INBOUND_FILE_MAX_BYTES` or `TELEGRAM_MAX_FILE_SIZE_BYTES` changes the default 50 MiB Telegram download limit.
- **Outbound attachment limit**: `PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES` or `TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES` changes the default 50 MiB `telegram_attach` delivery limit.

Assistant Markdown is delivered through Telegram's native Rich Message API. There is no `telegram.json` rendering toggle: final replies use `sendRichMessage`, and streaming previews use `sendRichMessageDraft` when Telegram drafts are available.

Long-running Telegram turns use Telegram's native active status as the activity indicator: technically Bot API `sendChatAction(typing)`, presented in product language as `...active` even when Telegram clients render it as typing dots. Active status is the only automatic in-chat work signal before the final reply.

Set these variables before launching Pi. Some transport defaults (notably Telegram temp directory and inbound/outbound byte-limit constants) are intentionally captured when the extension modules load, while setup-token defaults and agent-dir lookups used by config/locks are read through their runtime helpers.

## Use

Once paired, chat with your bot in Telegram. Text, images, files, replies, edits, media groups, and configured handler output are forwarded into Pi as Telegram-originated turns.

What it feels like:

- Start work in the terminal, walk away, and keep supervising the same live Pi session from Telegram.
- Open `/start` and get a Telegram control panel for the running Pi session: status, prompt templates, model, thinking, settings, and queue.
- Fire off three tasks while Pi is busy. They become visible queue items instead of terminal noise.
- Open Queue from the menu, inspect waiting work, delete stale prompts, or move important work forward.
- Switch models from Telegram mid-run; the adapter schedules a safe continuation instead of tearing state apart.
- Send a voice note; a configured inbound handler or registered STT provider transcribes it; Pi answers in the same chat.
- Drop a screenshot and ask, "what is broken here?" The image payload reaches Pi with the local file context.
- Ask for a generated file; when Pi calls `telegram_attach`, the artifact returns with the active Telegram reply or is sent directly to the paired/default chat from local work.

### Telegram controls

Use these inside the Telegram DM with your bot. The main entrypoint is `/start`: it opens the operator menu and exposes many of the important agent controls that can be safely adapted through Pi's extension APIs. The bot does not forward arbitrary terminal slash commands or emulate TUI-only session controls.

- **`/start`**: Pair the first Telegram user when needed, register bot commands, and open the inline application menu with command help, prompt-template commands, status rows, model controls, thinking controls, settings, and queue controls.
- **`/compact`**: Ask for inline confirmation, then start session compaction when the session is idle; Telegram shows the native active indicator while manual or automatic compaction is running.
- **`/next`**: Dispatch the next queued turn, aborting Pi first if needed.
- **`/continue`**: Enqueue a priority `continue` prompt.
- **`/abort`**: Abort the active run without touching the queue. Abort-history applies only to Telegram-owned active turns; later local prompts do not make the next Telegram prompt absorb older queue items.
- **`/stop`**: Abort the active run and clear waiting Telegram queue items.

Hidden compatibility shortcuts: `/help` and `/status` open the main application menu, `/model` opens model controls, `/thinking` opens reasoning controls, `/queue` opens queue controls, and `/settings` opens bridge settings.

Prompt-template commands are discovered from Pi prompt templates, mapped to Telegram-safe aliases (`fix-tests.md` becomes `/fix_tests`), shown in `/start`, and expanded before queueing.

### Pi commands

Run these inside Pi, not Telegram:

- **`/telegram-setup`**: Configure or update the Telegram bot token.
- **`/telegram-connect`**: Start polling Telegram updates in the current Pi session and acquire the singleton lock.
- **`/telegram-disconnect`**: Stop polling in the current Pi session and release the singleton lock.
- **`/telegram-status`**: Inspect adapter status, connection, polling, execution, queue, and recent redacted runtime/API failure events.

### Files and artifacts

Send files or images directly to the bot. Inbound downloads are saved under `<agent-dir>/tmp/telegram` and default to a 50 MiB limit. The agent dir is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it.

If you ask Pi for a generated file, Pi can call `telegram_attach`: during a Telegram-originated turn the adapter sends it with the next Telegram reply, and during local/TUI work it sends directly to the paired/default chat, a registered follower's assigned thread, or explicit `chat_id` plus optional `thread_id`. Local work can also use `telegram_message` when you explicitly ask the agent to push a Markdown text message to Telegram; embedded `telegram_button` comments are parsed and attached to that message. Direct local/TUI delivery requires the current Pi instance to own `/telegram-connect`, or to be registered with an explicitly enabled multi-instance bus so it can route through the leader; if neither is true, take over or enable/register with the bus before sending. Outbound attachments default to a 50 MiB limit. Environment variables for both limits are listed in [Environment-only configuration](#environment-only-configuration).

### Telegram Threaded Mode and multi-instance bus

Telegram private-chat Threaded Mode is the switch. Classic single-DM polling is the base mode. When Telegram reports private-chat threads are available for the bot, the adapter enables the local leader/follower bus automatically; when threads are unavailable or later disabled, it uses classic single-DM polling as the ordinary private-bot mode.

Only the leader calls `getUpdates`; followers authenticate to the local bus and route allowlisted, target-scoped Telegram work through the leader. When private-chat threads are available, they become the UI targets:

- The leader owns one thread;
- Each explicitly connected follower gets one visible thread;
- Telegram never launches hidden Pi follower processes;
- New thread names are assigned by the bridge from a compact curated palette, while existing human names are preserved;
- Unknown owner-created threads preserve the original prompt and offer a target-thread chooser instead of spawning work invisibly;
- Stale follower tabs receive compact lifecycle notices before cleanup when the leader can prove ownership.

Thread input is still authorized by `allowedUserId`. There is no separate public `telegram.json` switch for the bus: Telegram capability detection is the runtime source of truth. Native Windows Threaded Mode smoke remains tracked in `BACKLOG.md`; the intended transport is the same local bus over Windows named pipes instead of Unix sockets.

## Core features

### Operator menu and controls

The inline application menu is the primary operator surface. It exposes status, prompt-template commands, companion-extension Telegram commands, model selection, thinking level selection, settings, and queue inspection/mutation: a Telegram-shaped subset of the important handles normally available from the CLI. A typical control loop stays inside Telegram: open `/start`, inspect status, jump into Queue, delete stale work, switch model, return to the main menu, and keep the Pi session running without touching the terminal.

### Queue runtime

Messages sent while Pi is busy enter the prompt queue and are processed in order. Control actions and model-switch continuation turns use higher-priority lanes. Queue processing and reply delivery stay local to the Pi instance that accepted the work, even if `/telegram-connect` later moves elsewhere.

The menu is the primary way to inspect and mutate the queue. Reactions are an extra shortcut when Telegram delivers `message_reaction` updates for the chat. The same rules apply to text, voice, files, images, and media groups:

- Priority shortcuts: `👍`, `⚡️`, `❤️`, `🕊`, and `🔥` promote waiting work.
- Removal shortcuts: `👎`, `👻`, `💔`, `💩`, and `🗑` remove waiting work from the queue.

### Streaming and native Rich Markdown

Assistant Markdown is sent to Telegram as native Rich Markdown. Streaming previews use Telegram rich-message drafts when a structurally closed Markdown prefix is available, and final replies persist the complete Markdown through `sendRichMessage`. The bridge still strips top-level hidden action comments before delivery and splits only when Telegram transport limits require it.

Telegram HTML rendering remains the default for bridge-owned UI surfaces such as commands, menus, status messages, queue controls, and extension sections, where explicit markup is clearer and easier to maintain. Native Rich Markdown is reserved for model-authored Markdown replies and guest replies that naturally arrive as Markdown.

### Media, replies, edits, and split text

Telegram replies to earlier text or caption messages are forwarded as `[reply]` context for normal prompts, while slash commands still parse from the new message text only. If a Telegram message is edited while still waiting in the queue, the queued turn is updated instead of duplicated. Very long text messages that Telegram appears to split automatically are coalesced through a conservative debounce when the first chunk is near Telegram's text limit.

### Inbound handlers and STT providers

`telegram.json` can define ordered `inboundHandlers` for Telegram → Pi preprocessing: text translation, voice transcription, OCR, PDF extraction, or any command-template pipeline. Matching handlers run before the turn enters the queue; failed handlers record diagnostics and fall back safely. Legacy `attachmentHandlers` still work as a deprecated compatibility alias appended after `inboundHandlers`.

A practical voice setup is simple: Telegram `.ogg` arrives, STT runs locally or through your chosen command, stdout is injected as `[outputs]`, and Pi receives the result as usable prompt context. Extensions can also register programmatic inbound handlers; full voice extensions can register transcription providers. Explicit `inboundHandlers` and legacy `attachmentHandlers` run first, then programmatic inbound handlers, then registered STT providers as fallback for voice/audio files.

```json
{
  "inboundHandlers": [
    {
      "type": "text",
      "template": "/path/to/translate --lang {lang=en} --text \"{text}\""
    },
    {
      "type": "voice",
      "template": [
        "/path/to/stt --file {file} --lang {lang=ru}",
        "/path/to/translate-stdin --lang {lang=en}"
      ]
    },
    {
      "mime": "audio/*",
      "template": [
        "/path/to/stt-fallback --file {file} --lang {lang=ru}",
        "/path/to/translate-stdin --lang {lang=en}"
      ]
    }
  ]
}
```

### Outbound handlers, voice synthesis providers, and buttons

Assistant replies can include hidden outbound blocks. `telegram_voice` and `telegram_button` are not Pi tools; they are assistant-authored HTML comments that the adapter removes from Telegram text and handles after `agent_end`. Recognized blocks must start at column zero on a top-level line outside fenced code, quotes, lists, and indented examples. Do not use JSON button specs, inline comments after visible text, or standalone button tool calls; write normal Markdown plus hidden comments, and add visible parent text if buttons would otherwise be the only output.

Prompt guidance is context-aware: unconfigured sessions receive no Telegram suffix, local/TUI prompts only get explicit direct-delivery guidance, and Telegram-originated turns get the full phone-width output and action-comment contract.

```md
Full technical answer stays readable as text.

<!-- telegram_voice lang=ru rate=+30%
Text to synthesize as a Telegram voice message.
-->

<!-- telegram_button label="Show risks"
List the main risks first.
-->
```

Outbound `type: "text"` handlers can transform final text/Markdown before native Rich Markdown delivery. Voice output can be handled either by configured `outboundHandlers` with `type: "voice"` or by registered voice synthesis provider extensions: the bridge extracts `telegram_voice` text or intercepts text by reply mode, asks the voice pipeline for a `.ogg`/`.opus` artifact, and uploads it through Telegram `sendVoice`. Explicit configured voice handlers run before zero-config providers, so operator-owned `telegram.json` pipelines stay authoritative.

The agent writes intent; providers or voice handlers own TTS and format conversion, the adapter owns Telegram transport, and buttons route back as queued prompts.

### Voice reply policies

The bridge can automatically convert agent text replies into Telegram voice messages without requiring explicit `<!-- telegram_voice -->` markup in every response. Configure this from Settings → `Voice reply` or by setting `voice.replyMode` in `telegram.json`:

- `hidden` (default): no `voice.replyMode` is stored. Behavior is manual, but prompt context stays silent.
- `manual`: agent-authored `<!-- telegram_voice -->` markup is required for voice replies; no automatic conversion. Unlike `hidden`, this explicit mode adds `[voice] reply mode: manual` context.
- `mirror`: when the user sends a voice message, the next reply is converted to voice and text preview is suppressed. Text-originated turns stay on the normal/manual text path, so agent-authored `<!-- telegram_voice -->` markup still works explicitly.
- `always`: every reply is converted to voice and text preview is suppressed.

If `telegram.json` explicitly sets a valid `voice.replyMode`, prompts include compact `[voice] reply mode: ...` context after handler outputs. When the field is missing or invalid, behavior still defaults to manual/hidden and the prompt context stays silent.

In `mirror` and `always` modes, the bridge transparently intercepts agent text responses and routes them through the outbound voice pipeline. Configured `outboundHandlers` with `type: "voice"` run first in their configured order; zero-config registered synthesis providers run after them as progressive fallbacks. If several synthesis providers are installed, they are tried in registration order and the first one that returns a valid `.ogg`/`.opus` artifact handles the reply; `undefined`, errors, or invalid output fall through to the next provider. If every voice generator fails, the bridge falls back to sending the text reply instead.

Voice synthesis provider extensions register TTS backends at runtime through public API domain subpaths. Providers use durable ids, receive the text plus optional `lang`/`rate` hints, and must return `.ogg` or `.opus` artifacts. The bridge tries configured `type: "voice"` handlers first, then programmatic handlers, then registered synthesis providers in registration order.

Provider examples and diagnostics live in [Voice Integration](./docs/voice.md) and [Public API](./docs/public-api.md). Boundary: providers own TTS; `pi-telegram` owns reply policy, prompt context, fallback ordering, and Telegram transport.

### Extension interop

Unknown inline-button callbacks are forwarded to Pi as `[callback] <data>` when they do not belong to pi-telegram, so other extensions can namespace and handle Telegram buttons without polling the bot themselves. Layered extensions that need synchronous update handling can register a handler on the shared update registry.

### Extension Sections

Ordinary pi extensions can register Telegram-native slash commands, structured UI sections, and compact status lines without owning a second polling loop. Slash commands use explicit opt-in registration from `@llblab/pi-telegram/commands`, so workflow-specific commands can live in companion extensions instead of expanding the core bridge command set. UI sections appear in the main Telegram menu and Settings submenu, default to explicit Telegram HTML UI markup, and may explicitly choose Markdown or plain text when that better matches their content; status lines allow widgets such as quota indicators to appear beside Status, Usage, Cost, and Context only when relevant to the active model. Each section gets a narrow typed context with `edit`, `open`, `enqueuePrompt`, `answerCallback`, and `callbackData()` — enough to build interactive Telegram-native surfaces while `pi-telegram` owns transport, callback routing, navigation hierarchy, and diagnostics.

Import `registerTelegramSection()` from `@llblab/pi-telegram/sections` and return a disposer on shutdown. Sections can send interactive messages directly into the chat via `ctx.open()` — confirmation dialogs, approve/deny gates, and multi-step forms live outside the menu hierarchy while callbacks route through the same typed handler. See [`@llblab/pi-telegram-extension-demo`](https://github.com/llblab/pi-telegram-extension-demo) for a working reference and the [Extension Sections Standard](./docs/sections.md) for the full contract.

### Proactive push

`telegram.json` can set `proactivePush: true` to send successful local non-Telegram final replies to Telegram when no Telegram turn is active and this Pi instance currently owns `/telegram-connect` or is registered as a Threaded Mode follower. Non-owners skip proactive delivery instead of pushing unrelated local/headless results through a bot they no longer control. Local prompt text is not mirrored because the bot does not own terminal user messages. The mode is off by default and can be toggled from settings.

### Time context

`telegram.json` can opt into a compact `[time]` line in Telegram-originated prompts so Pi has a wall-clock reference for requests such as "today", "now", or scheduling. It is hidden by default and uses the system timezone; the mode can also be changed from Settings → `🕒 Time injection`.

```json
{
  "time": {
    "injectionMode": "interval",
    "interval": 3600000
  }
}
```

Modes are `hidden`, `always`, and `interval`. `hidden` means no time line is added to prompt context. `interval` is measured in milliseconds and rate-limits the time line per chat in memory, so back-to-back messages do not repeatedly spend context on the same timestamp. When present, `[time]` is the final prompt-context section after attachments, handler outputs, and voice policy.

## Docs

- [Project Context](./AGENTS.md): durable engineering conventions and architecture constraints.
- [Open Backlog](./BACKLOG.md): planned work and known follow-ups.
- [Changelog](./CHANGELOG.md): completed delivery history.
- [Documentation Index](./docs/README.md): technical docs hub.
- [Architecture](./docs/architecture.md): runtime and subsystem overview.
- [Public API](./docs/public-api.md): stable commands, config, package entrypoints, assistant markup, and extension APIs.
- [Inbound Handlers](./docs/inbound.md): Telegram → Pi preprocessing.
- [Outbound Handlers](./docs/outbound.md): final text, voice, and artifact pipelines.
- [Command Templates](./docs/command-templates.md): portable command-template contract.
- [Callback Namespaces](./docs/callback-namespaces.md): callback interop for layered extensions.
- [Updates](./docs/updates.md): shared update interception.
- [Extension Sections](./docs/sections.md): Telegram extension sections platform for loading extensions that register UI surfaces.
- [Voice Integration](./docs/voice.md): voice reply policies, transparent interception, and provider extension API.
- [Locks](./docs/locks.md): singleton polling ownership.
- [UI Style](./docs/ui-style.md): inline button, toggle, tab, option-list, card, and dialog style guide.

## Notes

- The extension intentionally keeps rich visual/TUI configuration minimal for now. For advanced setup, ask an agent to read this README and the docs, then update `~/.pi/agent/telegram.json` for your workflow.
- Replies to Telegram prompts are sent as Telegram replies to the source message when possible; if the source message is unavailable, delivery falls back to a normal message.
- Temporary inbound Telegram files are cleaned up on later session starts.

## Companion Extensions

Third-party extensions that integrate with `pi-telegram`:

- [`pi-codex-usage`](https://github.com/llblab/pi-codex-usage) — Compact Codex subscription quota/status widget for the Pi statusline and the inline menu status text opened by `/start`.

```bash
pi install npm:@llblab/pi-codex-usage
```

- [`pi-telegram-tool-status`](https://github.com/Timur00Kh/pi-telegram-tool-status) — Live-updating service messages that list tools used by the agent. It keeps one message per Telegram prompt and edits it in place as tools execute.

```bash
pi install npm:pi-telegram-tool-status
```

- [`pi-xai-voice`](https://github.com/luxus/pi-xai-voice) — Companion extension that adds xAI-powered TTS for voice reply policies and `telegram_voice` markup.

```bash
pi install npm:pi-xai-voice
```

## License

MIT
