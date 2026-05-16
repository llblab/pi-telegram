# pi-telegram

![pi-telegram screenshot](screenshot.png)

**Telegram runtime adapter for π.**

`pi-telegram` turns a private Telegram DM into a session-local operator console for π. It admits work, preserves context, streams readable replies, keeps busy sessions usable through queues, lets other extensions share one bot, and turns assistant-authored intent into native Telegram artifacts.

This repository is an actively maintained fork of [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram). It started from upstream commit [`cb34008`](https://github.com/badlogic/pi-telegram/commit/cb34008460b6c1ca036d92322f69d87f626be0fc) and has since diverged substantially.

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

### 2. Configure the bot token in π

Start π, then run:

```bash
/telegram-setup
```

Paste your bot token when prompted. If a bot token is already saved in `~/.pi/agent/telegram.json`, the setup prompt shows that stored value by default. Otherwise it prefills from the first configured environment variable in `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, or `TELEGRAM_KEY`. The saved config file is written atomically with private `0600` permissions.

### 3. Connect this π session

```bash
/telegram-connect
```

The adapter is session-local: only one π instance polls Telegram at a time. `/telegram-connect` records polling ownership in `~/.pi/agent/locks.json`; live ownership moves require confirmation, while `/new` and same-`cwd` process restarts resume automatically.

### 4. Pair your Telegram account

1. Open the DM with your bot in Telegram
2. Send `/start`

The first user to message the bot becomes the exclusive owner of the adapter. Messages from other users are ignored.

### Environment-only configuration

Most day-to-day controls live in the Telegram menu or π commands. A few important runtime knobs intentionally stay in environment variables because they affect bootstrap, networking, or transport limits before a menu can help:

- **Bot token bootstrap**: `/telegram-setup` can prefill from `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, or `TELEGRAM_KEY` when no token is already saved.
- **HTTP/HTTPS proxy**: native `fetch` can use `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` when Node's environment proxy mode is enabled. Use `NODE_USE_ENV_PROXY=1` or start Node with `--use-env-proxy`. SOCKS5 is not part of the zero-dependency core. If you need it, run a local HTTP-to-SOCKS bridge or system tunnel and point `HTTP_PROXY` / `HTTPS_PROXY` at the HTTP endpoint.
- **Agent data root / temp location**: `PI_CODING_AGENT_DIR` changes the base agent directory used for `telegram.json`, locks, generated outbound-handler artifacts, and Telegram temp files. When unset, the adapter uses `~/.pi/agent`, so inbound Telegram files land in `~/.pi/agent/tmp/telegram`.
- **Inbound file limit**: `PI_TELEGRAM_INBOUND_FILE_MAX_BYTES` or `TELEGRAM_MAX_FILE_SIZE_BYTES` changes the default 50 MiB Telegram download limit.
- **Outbound attachment limit**: `PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES` or `TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES` changes the default 50 MiB `telegram_attach` delivery limit.

## Use

Once paired, chat with your bot in Telegram. Text, images, files, replies, edits, media groups, and configured handler output are forwarded into π as Telegram-originated turns.

What it feels like:

- Open `/start` and get a Telegram control panel for the running π session: status, prompt templates, model, thinking, settings, and queue.
- Fire off three tasks while π is busy. They become visible queue items instead of terminal noise.
- Open Queue from the menu, inspect waiting work, delete stale prompts, or move important work forward.
- Switch models from Telegram mid-run; the adapter schedules a safe continuation instead of tearing state apart.
- Send a voice note; an inbound handler transcribes it; π answers in the same chat.
- Drop a screenshot and ask, "what is broken here?" The image payload reaches π with the local file context.
- Ask for a generated file; when π calls `telegram_attach`, the artifact returns to Telegram with the next reply.

### Telegram controls

Use these inside the Telegram DM with your bot. The main entrypoint is `/start`: it opens the operator menu and exposes many of the important agent controls that normally live in the CLI, adapted for Telegram.

- **`/start`**: Pair the first Telegram user when needed, register bot commands, and open the inline application menu with command help, prompt-template commands, status rows, model controls, thinking controls, settings, and queue controls.
- **`/compact`**: Start session compaction when the session is idle; Telegram shows the native typing indicator while compaction is running.
- **`/next`**: Dispatch the next queued turn, aborting π first if needed.
- **`/continue`**: Enqueue a priority `continue` prompt.
- **`/abort`**: Abort the active run without touching the queue.
- **`/stop`**: Abort the active run and clear waiting Telegram queue items.

Hidden compatibility shortcuts: `/help` and `/status` open the main application menu, `/model` opens model controls, `/thinking` opens reasoning controls, `/queue` opens queue controls, and `/settings` opens bridge settings.

Prompt-template commands are discovered from π prompt templates, mapped to Telegram-safe aliases (`fix-tests.md` becomes `/fix_tests`), shown in `/start`, and expanded before queueing.

### π commands

Run these inside π, not Telegram:

- **`/telegram-setup`**: Configure or update the Telegram bot token.
- **`/telegram-connect`**: Start polling Telegram updates in the current π session and acquire the singleton lock.
- **`/telegram-disconnect`**: Stop polling in the current π session and release the singleton lock.
- **`/telegram-status`**: Inspect adapter status, connection, polling, execution, queue, and recent redacted runtime/API failure events.

### Files and artifacts

Send files or images directly to the bot. Inbound downloads are saved under `<agent-dir>/tmp/telegram` and default to a 50 MiB limit. The agent dir is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it.

If you ask π for a generated file, π can call the `telegram_attach` tool and the adapter sends the file with the next Telegram reply. Outbound attachments also default to a 50 MiB limit. Environment variables for both limits are listed in [Environment-only configuration](#environment-only-configuration).

## Core features

### Operator menu and controls

The inline application menu is the primary operator surface. It exposes status, prompt-template commands, model selection, thinking level selection, settings, and queue inspection/mutation: a Telegram-shaped subset of the important handles normally available from the CLI. A typical control loop stays inside Telegram: open `/start`, inspect status, jump into Queue, delete stale work, switch model, return to the main menu, and keep the π session running without touching the terminal.

### Queue runtime

Messages sent while π is busy enter the prompt queue and are processed in order. Control actions and model-switch continuation turns use higher-priority lanes so operational commands can resume before normal prompts.

The menu is the primary way to inspect and mutate the queue. Reactions are an extra shortcut when Telegram delivers `message_reaction` updates for the chat: `👍`, `⚡️`, `❤️`, `🕊`, and `🔥` promote waiting work; `👎`, `👻`, `💔`, `💩`, and `🗑` remove it. The same rules apply to text, voice, files, images, and media groups.

### Streaming and Telegram HTML rendering

Closed Markdown blocks stream back as rich Telegram HTML while π is generating. The growing tail stays conservative until the final rendered reply lands. Long replies are split below Telegram limits without intentionally breaking HTML structures, links, code blocks, blockquotes, lists, or code fences.

Rendering is phone-aware: tables and lists stay narrow, table padding accounts for emoji graphemes and wide Unicode display width, unsupported link forms degrade safely, and block spacing stays faithful to the original Markdown.

### Media, replies, edits, and split text

Telegram replies to earlier text or caption messages are forwarded as `[reply]` context for normal prompts, while slash commands still parse from the new message text only. If a Telegram message is edited while still waiting in the queue, the queued turn is updated instead of duplicated. Very long text messages that Telegram appears to split automatically are coalesced through a conservative debounce when the first chunk is near Telegram's text limit.

### Inbound handlers

`telegram.json` can define ordered `inboundHandlers` for Telegram → π preprocessing: text translation, voice transcription, OCR, PDF extraction, or any command-template pipeline. Matching handlers run before the turn enters the queue; failed handlers record diagnostics and fall back safely. Legacy `attachmentHandlers` still work as a deprecated compatibility alias appended after `inboundHandlers`.

A practical voice setup is simple: Telegram `.ogg` arrives, STT runs locally or through your chosen command, stdout is injected as `[outputs]`, and π receives the result as usable prompt context.

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

### Outbound handlers, voice, and buttons

Assistant replies can include hidden outbound blocks. `telegram_voice` and `telegram_button` are not π tools; they are assistant-authored HTML comments that the adapter removes from Telegram text and handles after `agent_end`. Recognized blocks must start at column zero on a top-level line outside fenced code, quotes, and lists.

```md
Full technical answer stays readable as text.

<!-- telegram_voice lang=ru rate=+30%
Text to synthesize as a Telegram voice message.
-->

<!-- telegram_button label="Show risks"
List the main risks first.
-->
```

Outbound `type: "text"` handlers can transform final text/Markdown before Telegram rendering and delivery. Outbound `type: "voice"` handlers can translate, synthesize, and convert hidden `telegram_voice` text into Telegram-native OGG/Opus voice through the same command-template contract used by inbound handlers.

A composed voice pipeline can translate, synthesize, and convert in one pass:

```json
{
  "outboundHandlers": [
    {
      "type": "voice",
      "template": [
        "/path/to/translate-stdin --lang {lang=ru}",
        "/path/to/tts-from-stdin --lang {lang=ru} --rate {rate=+30%} --write-media {mp3}",
        "ffmpeg -y -i {mp3} -c:a libopus -b:a 32k -ar 16000 -ac 1 -vbr on {ogg}"
      ],
      "output": "ogg"
    }
  ]
}
```

The agent writes intent; the adapter owns transport. Text remains readable, voice becomes native Telegram media, and buttons route back as queued prompts.

### Extension interop

Unknown inline-button callbacks are forwarded to π as `[callback] <data>` when they do not belong to pi-telegram, so other extensions can namespace and handle Telegram buttons without polling the bot themselves. Layered extensions that need synchronous update handling can register a runtime interceptor on the shared update registry.

### Extension Sections

Ordinary pi extensions can register structured UI sections that appear in the main Telegram menu and Settings submenu without owning a second poller. Each section gets a narrow typed context with `edit`, `open`, `enqueuePrompt`, `answerCallback`, and `callbackData()` — enough to build interactive Telegram-native surfaces while `pi-telegram` owns transport, callback routing, navigation hierarchy, and diagnostics.

Import from `@llblab/pi-telegram`, call `registerTelegramSection()`, and return a disposer on shutdown. Sections can send interactive messages directly into the chat via `ctx.open()` — confirmation dialogs, approve/deny gates, and multi-step forms live outside the menu hierarchy while callbacks route through the same typed handler. See [`@llblab/pi-telegram-extension-demo`](https://github.com/llblab/pi-telegram-extension-demo) for a working reference and the [Extension Sections Standard](./docs/extension-sections.md) for the full contract.

### Proactive push

`telegram.json` can set `proactivePush: true` to send successful local non-Telegram final replies to the paired Telegram chat when no Telegram turn is active. Local prompt text is not mirrored because the bot does not own terminal user messages. The mode is off by default and can be toggled from settings.

## Docs

- [Project Context](./AGENTS.md): durable engineering conventions and architecture constraints.
- [Open Backlog](./BACKLOG.md): planned work and known follow-ups.
- [Changelog](./CHANGELOG.md): completed delivery history.
- [Documentation Index](./docs/README.md): technical docs hub.
- [Architecture](./docs/architecture.md): runtime and subsystem overview.
- [Inbound Handlers](./docs/inbound-handlers.md): Telegram → π preprocessing.
- [Outbound Handlers](./docs/outbound-handlers.md): final text, voice, and artifact pipelines.
- [Command Templates](./docs/command-templates.md): portable command-template contract.
- [Callback Namespaces](./docs/callback-namespaces.md): callback interop for layered extensions.
- [External Handlers](./docs/external-handlers.md): shared update interception.
- [Extension Sections](./docs/extension-sections.md): Telegram extension sections platform for loading extensions that register UI surfaces.
- [Locks](./docs/locks.md): singleton polling ownership.

## Notes

- The extension intentionally keeps rich visual/TUI configuration minimal for now. For advanced setup, ask an agent to read this README and the docs, then update `~/.pi/agent/telegram.json` for your workflow.
- Replies to Telegram prompts are sent as Telegram replies to the source message when possible; if the source message is unavailable, delivery falls back to a normal message.
- Temporary inbound Telegram files are cleaned up on later session starts.

## Companion Extensions

Third-party extensions that integrate with `pi-telegram`:

- [`pi-telegram-tool-status`](https://github.com/Timur00Kh/pi-telegram-tool-status) — Live-updating service messages that list tools used by the agent. It keeps one message per Telegram prompt and edits it in place as tools execute.

```bash
pi install npm:pi-telegram-tool-status
```

## License

MIT
