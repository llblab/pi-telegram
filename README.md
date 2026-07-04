# pi-telegram

![pi-telegram banner](banner.png)

**A Telegram companion hub for live Pi sessions.**

`pi-telegram` turns a private Telegram DM into a mobile operator surface for Pi. It accepts prompts, queues work, streams readable previews, delivers final replies and files, exposes safe controls, and lets companion extensions add Telegram-native capabilities without owning a second bot loop.

It is a **runtime adapter**, not a remote terminal. Start or supervise work in the Pi TUI, then continue from Telegram while away from the keyboard. The bridge preserves Pi session semantics instead of pretending Telegram is a PTY, shell, or process launcher. That boundary is the product: Telegram gets safe runtime handles, not raw terminal power.

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

## Quick Start

### 1. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather).
2. Run `/newbot`.
3. Pick a name and username.
4. Copy the bot token.

### 2. Configure Pi

Run this inside Pi:

```bash
/telegram-setup
```

Paste the bot token. If `~/.pi/agent/telegram.json` already contains a saved token, setup offers it as the default. If no saved token exists, setup can prefill from `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, or `TELEGRAM_KEY`.

### 3. Connect this Pi session

```bash
/telegram-connect
```

The connected Pi instance owns Telegram polling. In classic mode this is a singleton lock. When Telegram private-chat Threaded Mode is available, one live instance becomes the leader and later visible Pi instances register as followers.

### 4. Pair your Telegram account

Open the bot DM and send:

```text
/start
```

The first Telegram user to message the bot becomes the allowed owner. Other users are ignored.

## What It Feels Like

- Start a task in the terminal, walk away, and keep supervising it from your phone.
- Send another prompt while Pi is busy; it becomes a queued Telegram turn instead of interrupting the active run.
- Open `/start` to inspect status, model, thinking, settings, prompt templates, and queue controls.
- Send voice, images, files, replies, edits, or media groups; the bridge turns them into Pi context.
- Ask for an artifact; `telegram_attach` returns it through the active reply or direct Telegram delivery.
- In Threaded Mode, run multiple visible Pi instances through one bot, each with its own Telegram thread.

## Product Model

| Lens | What `pi-telegram` owns |
| --- | --- |
| Operator companion | A phone-width control surface for a live Pi session |
| Runtime adapter | Telegram turns mapped into Pi lifecycle, queueing, previews, final replies, and artifacts |
| Telegram UI harness | Menus, settings, callbacks, Rich Markdown, drafts, active status, buttons, voice, and files |
| Multi-instance organism | One leader plus explicit visible followers routed through Telegram private-chat threads |
| Extension platform | Commands, sections, status rows, update handlers, inbound/outbound handlers, and voice providers |
| Safety boundary | No hidden Pi processes, no fake terminal, no PTY tricks, no arbitrary TUI slash-command forwarding |

## Feature Showcase

`pi-telegram` is intentionally broad: it is a Telegram-shaped runtime surface, not only a message relay. This catalogue keeps the practical feature surface visible while detailed contracts stay in `/docs`.

| Surface | What you can do | Why it matters |
| --- | --- | --- |
| Prompt intake | Send text, replies, edits, images, files, albums, voice notes, and handler output into Pi. | Telegram becomes a real mobile input surface with file/context references, not just a text tunnel. |
| Queue control | Inspect waiting turns, delete stale work, promote important prompts, continue, abort, stop, or force the next queued item. | Long Pi tasks keep running while new mobile prompts stay visible and controllable instead of interrupting or disappearing. |
| Operator menu | Use `/start` for status, prompt templates, model, thinking, settings, queue, extension sections, and diagnostics. | The bot is an operator panel, not a command cheat sheet. |
| Prompt templates | Run Pi prompt templates as Telegram-safe commands such as `/fix_tests`. | Reusable local workflows become phone-accessible without exposing arbitrary terminal commands. |
| Model and thinking | Switch model or reasoning level from Telegram through safe continuation flows. | Mobile control can adjust execution strategy without tearing down the current session. |
| Compaction | Confirm `/compact`, show native active status during compaction, and preserve Telegram-owned turn semantics. | Context maintenance is visible and safe from the phone. |
| Draft previews | Show native active status by default, or enable Telegram Rich Draft previews while the agent is still working. | The operator can hide/show in-progress text independently from final rendering. |
| Assistant rendering | Choose Native Rich Markdown or legacy Markdown-to-HTML for final assistant replies. | Renderer compatibility is explicit instead of being conflated with draft previews. |
| Bridge UI rendering | Render tool rows, reasoning/technical steps, menus, queue controls, status, settings, diagnostics, and sections through explicit Telegram HTML/plain UI. | Harness-owned surfaces remain operationally predictable and visually distinct from model-authored answers. |
| Inbound files | Download inbound files to the Pi agent temp directory with size limits. | Screenshots, PDFs, datasets, and artifacts enter Pi as inspectable local files. |
| Outbound artifacts | Return generated files through `telegram_attach` during active turns or explicit direct delivery. | Agents send real artifacts as files, not pasted blobs. |
| Voice input | Route audio through configured command-template handlers, programmatic handlers, or STT providers. | Voice notes become usable prompt context. |
| Voice output | Use `telegram_voice`, reply modes, configured voice handlers, and TTS providers. | Replies can become Telegram voice messages when the workflow calls for it. |
| Buttons | Turn top-level `telegram_button` comments into inline buttons. | Assistant-authored choices become native Telegram interactions. |
| Callback routing | Route known callbacks to the owner extension and unknown callbacks back into Pi. | Companion extensions can build UI without polling Telegram themselves. |
| Threaded Mode | Run one leader plus visible follower Pi instances through named private-chat threads. | One bot can host a local multi-instance Pi organism without hidden process spawning. |
| Reroute and restore | Preserve unknown threads and offer explicit target choices. | Telegram client state can be repaired without silently deleting or hijacking prompts. |
| Extension sections | Add menu sections, commands, status rows, settings, callbacks, and delivery helpers from companion extensions. | `pi-telegram` becomes a platform surface for other Pi extensions. |
| Runtime diagnostics | Use `/telegram-status` and recent runtime events for connection, role, queue, transport, and failure evidence. | Debugging lives in the operator surface instead of hidden logs only. |
| Safety and ownership | Pair one owner, lock transport, scope targets, and reject fake terminal behavior. | Remote access remains explicit, bounded, and understandable. |

## Core Loop

```text
Telegram message
  -> Telegram turn
  -> queue or active dispatch
  -> Pi agent lifecycle
  -> streaming preview / native active status
  -> final Rich Markdown reply
  -> optional files, voice, buttons, or callback actions
```

The bridge keeps Telegram responsive without stealing Pi's runtime model. Queueing, model changes, compaction, aborts, final delivery, and direct artifact sends all stay scoped to the Pi instance that accepted the work.

## Telegram Controls

Use these in the bot DM.

| Command | Purpose |
| --- | --- |
| `/start` | Pair when needed and open the main operator menu |
| `/compact` | Confirm and run session compaction when safe |
| `/next` | Dispatch the next queued turn, aborting first if needed |
| `/continue` | Enqueue a priority continuation prompt |
| `/abort` | Abort the active run while preserving the queue |
| `/stop` | Abort the active run and clear waiting Telegram turns |

Hidden compatibility shortcuts: `/help`, `/status`, `/model`, `/thinking`, `/queue`, and `/settings` jump into the same menu system.

## Pi Commands

Run these inside Pi.

| Command | Purpose |
| --- | --- |
| `/telegram-setup` | Save or update the bot token |
| `/telegram-connect` | Start polling and acquire Telegram transport ownership |
| `/telegram-disconnect` | Stop polling and release ownership |
| `/telegram-status` | Inspect connection, mode, queue, transport, and recent diagnostics |

## Main Surfaces

### Operator Menu

`/start` opens the Telegram-native control panel: status, prompt-template commands, model selection, thinking level, settings, queue controls, and extension sections. It is the primary Telegram UI; reaction shortcuts are secondary queue affordances.

### Queue Runtime

Messages sent while Pi is busy become queued turns. Priority lanes support control actions and model-switch continuations. Queue controls let you inspect, delete, promote, and dispatch work from Telegram without touching the terminal.

### Native Rich Markdown

Rich Markdown is the default model-answer membrane. Complete assistant and guest model replies use Telegram's native Rich Message APIs, while tool-call rows, reasoning/thinking blocks, menus, status rows, queue controls, settings, diagnostics, and other harness-owned surfaces use explicit Telegram HTML/plain rendering. This keeps meaningful model-authored answers visually distinct from bridge-owned operational UI. Two Settings controls keep the layers separate: `Draft previews` toggles live `sendRichMessageDraft` frames, while `Assistant rendering` chooses final-answer delivery (`rich` Native Rich Markdown or `html` legacy Markdown-to-HTML).

### Files And Artifacts

Inbound files land under `<agent-dir>/tmp/telegram` and default to a 50 MiB limit. `telegram_attach` is the canonical outbound file path. During Telegram-originated turns it attaches to the active reply; during explicit local/TUI delivery it can send to the paired/default chat or routed Threaded Mode target.

### Voice And Media

Voice notes, audio, images, PDFs, and other media can pass through configured inbound handlers, programmatic handlers, or registered STT providers. Outbound voice can use configured `outboundHandlers` or registered TTS providers; `pi-telegram` owns reply policy and Telegram transport, while providers own synthesis.

### Buttons And Callbacks

Assistant replies can include top-level hidden `telegram_button` comments. The bridge strips the comments from visible text, renders inline buttons, and routes callbacks back into Pi as queued prompts or extension-owned callback actions.

### Threaded Mode And Multi-Instance Bus

Classic private DM mode is the base product mode. When Telegram private-chat Threaded Mode is available, the bridge enables a local leader/follower bus automatically:

- One live leader owns `getUpdates`.
- Followers are visible Pi processes started by the operator.
- Each connected instance gets a Telegram thread target.
- Unknown threads are preserved and offered explicit reroute/restore choices.
- Telegram never launches hidden Pi processes.

| Mode | Best for | Runtime shape |
| --- | --- | --- |
| Classic DM | One live Pi session controlled from one private bot chat | One polling owner, one queue/runtime surface |
| Threaded Mode | Several visible Pi terminals sharing one bot | One leader owns transport; followers route through named private-chat threads |

## Environment Configuration

Most controls live in Pi commands or the Telegram menu. Environment variables remain for bootstrap and transport boundaries:

| Area | Variables |
| --- | --- |
| Bot token bootstrap | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_KEY`, `TELEGRAM_TOKEN`, `TELEGRAM_KEY` |
| HTTP proxy | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, plus `NODE_USE_ENV_PROXY=1` or Node `--use-env-proxy` |
| Telegram network family | `PI_TELEGRAM_NETWORK_FAMILY=auto`, `ipv4`, `ipv6`, or `ipv4-fallback` |
| Agent data root | `PI_CODING_AGENT_DIR` |
| Inbound file limit | `PI_TELEGRAM_INBOUND_FILE_MAX_BYTES`, `TELEGRAM_MAX_FILE_SIZE_BYTES` |
| Outbound attachment limit | `PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES`, `TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES` |

Defaults are chosen for ordinary private-bot use: saved config in `~/.pi/agent`, inbound temp files in `~/.pi/agent/tmp/telegram`, `assistantRendering: "rich"` for final replies, `richDraftPreviews: false` for no live draft text by default, and native Telegram active status for long-running turns.

## Extension Platform

Companion extensions can integrate with Telegram without owning polling or transport:

- Register Telegram slash commands.
- Add menu sections and settings surfaces.
- Add compact status rows.
- Handle update/callback namespaces.
- Provide inbound preprocessing handlers.
- Provide outbound voice synthesis.
- Use direct delivery helpers for explicit local/TUI sends.

Stable public entrypoints are documented in [Public API](./docs/public-api.md), [Extension Sections](./docs/sections.md), [Inbound Handlers](./docs/inbound.md), [Outbound Handlers](./docs/outbound.md), [Updates](./docs/updates.md), and [Voice Integration](./docs/voice.md).

## Safety Boundaries

`pi-telegram` intentionally does not:

- Spawn hidden Pi follower processes.
- Pretend Telegram is a terminal or PTY.
- Forward arbitrary Telegram slash commands into the Pi TUI.
- Inject raw TTY input or terminal-control sequences.
- Replace Pi session lifecycle without an official Pi API.
- Let non-owner Telegram users control the bridge.

Telegram is a companion surface around a live Pi runtime, not a second runtime.

## Documentation Map

- [Architecture](./docs/architecture.md) — runtime, domains, queue, transport, and Threaded Mode overview.
- [Public API](./docs/public-api.md) — package entrypoints and stable companion-extension contracts.
- [Inbound Handlers](./docs/inbound.md) — Telegram-to-Pi preprocessing pipelines.
- [Outbound Handlers](./docs/outbound.md) — final text/voice/file transformation and delivery.
- [Voice Integration](./docs/voice.md) — STT/TTS provider model and reply policies.
- [Extension Sections](./docs/sections.md) — Telegram-native companion UI surfaces.
- [Updates](./docs/updates.md) — update handler registry and callback interop.
- [Multi-Instance Bus](./docs/multi-instance-bus.md) — leader/follower routing in Threaded Mode.
- [Locks](./docs/locks.md) — singleton ownership and shared lock conventions.
- [UI Style](./docs/ui-style.md) — menu, emoji, labels, dialogs, and inline keyboard standards.
- [Callback Namespaces](./docs/callback-namespaces.md) — callback ownership and routing.
- [Command Templates](./docs/command-templates.md) — handler command-template conventions.

The docs index lives at [docs/README.md](./docs/README.md).

## Development

```bash
npm run typecheck
npm test
npm run audit
npm run pack:check
```

Full validation:

```bash
npm run validate
```

Project context:

- [AGENTS.md](./AGENTS.md) — engineering and runtime conventions.
- [BACKLOG.md](./BACKLOG.md) — release-relevant open work.
- [CHANGELOG.md](./CHANGELOG.md) — completed delivery history.
