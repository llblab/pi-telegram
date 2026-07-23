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
- `/telegram-connect` — start polling here and acquire external Telegram control ownership. Accepted queue/reply state stays local if ownership later moves elsewhere.
- `/telegram-disconnect` — after destructive confirmation, stop polling and release ownership without deleting or silencing accepted local queue state. In Threaded Mode it deletes this instance's current Telegram thread; a follower waits for its active leader to confirm generation-fenced cleanup before stopping. Graceful Pi `quit` performs the same teardown without prompting, while `reload`, `new`, `resume`, and `fork` preserve same-process handoff.
- `/telegram-status` — show connection, polling, execution, queue, and recent event diagnostics.

### Telegram commands

Stable commands inside the paired Telegram DM:

- `/start` — pair when needed and open the main application menu.
- `/compact` — open confirmation and compact when idle.
- `/next` — dispatch the next queued turn, aborting active work first when needed.
- `/continue` — enqueue a priority `continue` prompt.
- `/abort` — abort active work and keep the queue; abort-history is scoped to Telegram-owned active turns.
- `/stop` — abort active Telegram-owned work and clear waiting Telegram queue items.

Hidden compatibility shortcuts may open sections directly: `/help`, `/status`, `/model`, `/thinking`, `/queue`, and `/settings`.

This command surface is a mobile companion subset, not a raw terminal-command bridge or session browser. A Telegram destination follows its assigned Pi instance and sends prompts into that instance's currently active session; it is not permanently bound to one session identity. Compaction operates on the current session, while new-session, resume, fork, tree navigation, session switching, TUI transcript clearing, and arbitrary slash-command dispatch stay out of the stable Telegram API unless Pi exposes safe public extension hooks for them.

### Tools and assistant-authored actions

- `telegram_attach(paths, chat_id?, thread_id?, caption?)` is the stable artifact delivery tool for generated files. During Telegram turns it queues files for the active reply; with `assistant.rendering: "rich"`, exactly one PNG/JPEG, MP4, or MP3 artifact plus non-empty final Markdown can become one reply-anchored Rich Message. HTML mode, multiple/unsupported files, Guest Mode, and voice outputs retain their established paths. Outside Telegram turns the tool sends files directly to the paired/default chat, the registered follower's assigned thread, or an explicit `chat_id` plus optional `thread_id` when this Pi instance owns `/telegram-connect` or is registered with the multi-instance bus.
- `telegram_message(text, chat_id?, thread_id?)` sends a direct Telegram Markdown message from local/TUI-initiated work when this Pi instance owns `/telegram-connect` or is registered with the multi-instance bus. Top-level `telegram_button` comments inside `text` are parsed with the same planner used for normal replies and attached to that message; buttons are never standalone Telegram messages.
- `telegram_help()` returns detailed agent-facing guidance for pi-telegram delivery actions, Threaded Mode, formatting, and debugging. The regular prompt only points agents at this tool instead of repeating the full guidance on every turn. `telegram_attach`, `telegram_message`, and `telegram_help` remain registered but are model-active only while this instance owns direct transport or holds a live follower registration; disconnect/loss suppresses their schemas and prompt metadata, and recovery restores only the operator's previously active pi-telegram subset.
- `telegram_voice` hidden comments request Telegram-native voice delivery.
- `telegram_button` hidden comments create inline buttons whose taps enqueue prompts. Use top-level column-zero comments outside code, quotes, lists, and indented examples; do not emit JSON button specs or standalone button actions.

Prompt guidance is context-aware: local/TUI prompts see only explicit direct-delivery guidance, while Telegram-originated turns receive the full action-comment syntax and phone-width output contract.

See [Outbound Handlers](./outbound.md) for exact markup forms.

## Configuration API

Configuration lives in `~/.pi/agent/telegram.json` unless `PI_CODING_AGENT_DIR` changes the agent root.

Stable config keys:

```ts
interface TelegramBotProfile {
  botToken: string;
  botUsername?: string; // runtime-managed
  botId?: number; // runtime-managed
  allowedUserId?: number;
  lastUpdateId?: number; // runtime-managed
}

interface TelegramConfig {
  profiles?: Record<string, TelegramBotProfile>; // includes `default`
  inboundHandlers?: TelegramInboundHandlerConfig[];
  attachmentHandlers?: TelegramInboundHandlerConfig[]; // compatibility alias
  outboundHandlers?: TelegramOutboundHandlerConfig[];
  assistant?: {
    draftPreviews?: boolean;
    rendering?: "rich" | "html";
    proactivePush?: boolean;
  };
  voice?: {
    replyMode?: "hidden" | "mirror" | "always";
    sendTranscript?: boolean;
  };
  time?: {
    injectionMode?: "hidden" | "always" | "interval";
    interval?: number;
  };
  threads?: {
    automaticCleanup?: boolean;
  };
}
```

Bot/session identity always persists under `profiles.<name>`. The ordinary setup path uses `profiles.default`; `/telegram-setup default` and `/telegram-connect default` are exact aliases for the bare commands. Named profiles use the same shape. Shared handlers plus `assistant`, `voice`, `time`, and `threads` remain top-level. On the first `0.24.0` load, unambiguous legacy root identity moves atomically into `profiles.default`; identical duplicates collapse, complementary fields merge, and conflicting values fail closed without modifying the file.

The file is global across Pi instances. Cooperating instances serialize recursive delta merges through `telegram.json.transaction`, preserve unrelated global/profile changes from newer disk snapshots, and merge `lastUpdateId` monotonically. A semantically unchanged merge adopts the latest disk state in memory without replacing the file; later commits win when two deltas intentionally change the same leaf. For manual edits, stop or idle the connected instances, publish a complete valid file atomically, and let them reload. A non-transactional editor racing Pi persistence has no same-leaf conflict guarantee.

Hidden/default semantics are represented by absence:

- `threads.automaticCleanup` defaults to `true`; graceful Pi quit deletes the instance's bound Threaded Mode tab without prompting. Set it to `false`, or use `🧹 Auto thread cleanup` in Telegram Settings, to preserve the tab as a restart hint. Settings views and graceful quit reload shared config before evaluating this switch, so another live Pi instance's update takes effect without restarting. Invalid-config recovery makes the quit-time setting unresolved and therefore skips destructive automatic cleanup. Manual `/telegram-disconnect` keeps its confirmation and teardown behavior regardless of this setting.
- `assistant.proactivePush` defaults to `true`; omit it to keep projection enabled, or set it explicitly to `false` to disable it. When enabled, each completed public assistant text block from local or autonomous work is projected to the authorized Telegram target once and in source order. This includes visible intermediate commentary/checkpoints and the final block. It excludes token deltas, hidden reasoning, tool calls/arguments/results, Telegram-owned turns, empty blocks, and stale authority. Projection uses the configured Rich or HTML assistant renderer and binds admitted work to the exact target, profile/token transport generation, direct leader epoch or follower registration generation, and session generation. The old top-level `proactivePush` key is ignored; move the setting manually under `assistant`.
- Voice Reply `hidden`: no `voice.replyMode` key is persisted; legacy `manual` resolves to this silent default. `mirror` adds `[voice] delivery: automatic voice` only to voice/audio-input turns, while `always` adds the same effective line to every Telegram turn.
- Agent activity status is not configurable in this release. Telegram uses native `sendChatAction(typing)` / product `...active` status as the only automatic in-chat work signal before the final reply.
- Time Injection `hidden`: no `time.injectionMode` key is persisted; if `time` becomes empty, the whole `time` object may be omitted.

With `assistant.rendering: "rich"` (the default), assistant Markdown delivery is native: final replies are sent as `InputRichMessage.markdown` via `sendRichMessage`, and draft previews use `sendRichMessageDraft` when a structurally closed preview frame is available. Draft-frame failures are recorded and skipped rather than converted into raw plain preview messages, because partial Markdown can be temporarily invalid while the final answer remains valid. Long native replies are split at Telegram Rich Message transport limits, with oversized fenced code, display-math, and fully wrapped inline-formatting blocks rewrapped per chunk so persisted chunks remain structurally valid. Guest replies use `InputRichMessageContent` in `answerGuestQuery` results. Bridge-owned UI surfaces such as menus, status, queue controls, commands, and sections keep explicit Telegram HTML/plain rendering by default because those texts are authored by the bridge or companion extensions for Telegram UI. Companion extension sections may explicitly request `"markdown"`, `"html"`, or `"plain"` per view. `assistant.rendering: "html"` keeps the compatibility path that converts assistant Markdown to Telegram HTML before ordinary message delivery. The bridge sets `skip_entity_detection: true` for assistant and guest Markdown so technical text such as `/commands`, hashtags, URLs, phone numbers, and card-like numbers does not gain unintended automatic entities; explicit Markdown links still belong in the Markdown source.

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
  - Purpose: ownership-gated operational delivery to active-turn, current-instance, aggregate, or explicitly authorized targets.
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
  - Purpose: observe or consume raw Telegram updates before default routing.
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
- **Programmatic target-aware delivery:** `/delivery` sends, edits, deletes, and signals operational views against active-turn, current-instance, aggregate, or explicitly authorized targets through generation-bound logical handles.
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
- The bridge renders rows as `<Label>: <value>` in the same HTML status block as Status, Usage, Cost, and Context, capitalizing the first label character for Telegram UI consistency.

## Updates

Import from `@llblab/pi-telegram/updates`.

```ts
const off = registerTelegramUpdateHandler(async (update) => {
  const data = (update as { callback_query?: { data?: string } }).callback_query
    ?.data;
  if (!data?.startsWith("myext:")) return "pass";
  await handleMyCallback(data);
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
    const audioPath = await synthesizeOggOpus(text, options);
    return getTelegramVoiceSendTranscript(getCurrentTelegramConfigView())
      ? { audioPath, transcriptText: text }
      : { audioPath };
  },
  { id: "@scope/my-extension/tts" },
);
```

Stable voice-provider registrations pass a durable `id`. Omitting `id` is a compatibility path for older providers and receives a generated session-local id. Providers return `undefined` to pass. TTS providers must return `.ogg` or `.opus` files for native Telegram voice notes. `voice.sendTranscript` is the bridge-owned transcript preference; providers that expose captions should gate `transcriptText` with `getTelegramVoiceSendTranscript(config)` instead of defining a second reply-policy toggle.

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
  getTelegramVoiceSendTranscript,
  registerTelegramVoiceSynthesisProvider,
  registerTelegramVoiceTranscriptionProvider,
} from "@llblab/pi-telegram/voice";

export default function demoVoice(pi: ExtensionAPI) {
  let unregisterTts: (() => void) | undefined;
  let unregisterStt: (() => void) | undefined;
  let currentConfig: { voice?: { sendTranscript?: boolean } } = {};
  pi.on("session_start", async () => {
    unregisterTts?.();
    unregisterStt?.();
    unregisterTts = registerTelegramVoiceSynthesisProvider(
      async (text) => {
        const audioPath = await synthesizeDemoOgg(text);
        return getTelegramVoiceSendTranscript(currentConfig)
          ? { audioPath, transcriptText: text }
          : { audioPath };
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

Owned prefixes are reserved by `pi-telegram`: `compact:`, `tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `settings:`, and `section:`.

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
